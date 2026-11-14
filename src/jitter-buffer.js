import { SEQ_MOD, extendSequence, seqDistance } from './sequence.js'
import { RingBuffer } from './ring-buffer.js'
import { leastSquaresSlope, movingMedian, quantile } from './stats.js'

export const ACTION = Object.freeze({
  WAIT: 'wait',
  PLAY: 'play',
  REPEAT: 'repeat',
  HIDE_LOSS: 'hide-loss',
  DISCARD: 'discard'
})

export const DEFAULT_OPTIONS = Object.freeze({
  tickMs: 20,
  minDelayMs: 40,
  maxDelayMs: 400,
  quantile: 0.9,
  hysteresisMs: 30,
  decreaseHoldTicks: 25,
  lossConfirmTicks: 2,
  maxConcealTicks: 10,
  interruptMs: 2000,
  maxBufferedFrames: 200,
  statsWindow: 128,
  maxDriftRate: 0.005,
  driftFilterWindow: 9
})

export class JitterBuffer {
  constructor(options = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options }
    if (!(Number.isFinite(opts.tickMs) && opts.tickMs > 0)) {
      throw new RangeError('tickMs 必须为正数')
    }
    if (!(opts.minDelayMs > 0 && opts.maxDelayMs >= opts.minDelayMs)) {
      throw new RangeError('需要满足 0 < minDelayMs <= maxDelayMs')
    }
    if (!(opts.quantile > 0 && opts.quantile <= 1)) {
      throw new RangeError('quantile 必须落在 (0, 1]')
    }
    if (opts.hysteresisMs < 0 || opts.decreaseHoldTicks < 1) {
      throw new RangeError('hysteresisMs 不能为负，decreaseHoldTicks 至少为 1')
    }
    if (opts.maxBufferedFrames < 1 || opts.statsWindow < 2) {
      throw new RangeError('maxBufferedFrames 与 statsWindow 容量不合法')
    }
    if (!(opts.maxDriftRate >= 0 && opts.maxDriftRate < 1)) {
      throw new RangeError('maxDriftRate 必须落在 [0, 1)')
    }
    this.options = Object.freeze({ ...opts })

    this.buffer = new Map()
    this.transitPairs = new RingBuffer(opts.statsWindow)

    this.targetDelay = opts.minDelayMs
    this.holdTicks = 0
    this.targetReason = 'init'
    this.driftSlope = 0
    this.playoutOffset = null

    this.initialized = false
    this.highestExtendedSequence = null
    this.nextSequence = null
    this.playedUpTo = null

    this.primed = false
    this.resyncReason = null
    this.needResync = false
    this.missedSince = null
    this.consecutiveConcealed = 0
    this.lastArrivalTime = null
    this.lastTickTime = null
  }

  pushFrame(frame) {
    if (frame === null || typeof frame !== 'object') {
      throw new TypeError('frame 必须是包含 sequence/captureTime/arrivalTime 的对象')
    }
    const { captureTime, arrivalTime } = frame
    if (!Number.isFinite(captureTime) || !Number.isFinite(arrivalTime)) {
      throw new TypeError('captureTime 与 arrivalTime 必须为有限数字')
    }
    if (arrivalTime < captureTime) {
      throw new RangeError('arrivalTime 不能早于 captureTime')
    }
    const sequence = ((Math.trunc(frame.sequence) % SEQ_MOD) + SEQ_MOD) % SEQ_MOD

    if (
      this.lastArrivalTime !== null &&
      arrivalTime - this.lastArrivalTime > this.options.interruptMs
    ) {
      this._handleInterruption()
    }

    if (!this.initialized) {
      this.initialized = true
      this.highestExtendedSequence = sequence
      this.nextSequence = sequence
      this.playedUpTo = sequence - 1
    } else if (this.needResync && this.buffer.size === 0) {
      this.highestExtendedSequence = sequence
      this.nextSequence = sequence
      this.playedUpTo = sequence - 1
      this.missedSince = null
      this.consecutiveConcealed = 0
    } else {
      const distance = seqDistance(sequence, this.highestExtendedSequence % SEQ_MOD)
      if (distance === 0 || this.buffer.has(this.highestExtendedSequence + distance)) {
        return { accepted: false, reason: 'duplicate-frame' }
      }
      if (distance < 0) {
        const extended = this.highestExtendedSequence + distance
        if (extended <= this.playedUpTo) {
          return { accepted: false, reason: 'late-frame-already-played' }
        }
      }
    }

    this.lastArrivalTime = arrivalTime

    const extended = extendSequence(this.highestExtendedSequence, sequence)
    this.highestExtendedSequence = Math.max(this.highestExtendedSequence, extended)

    const rawDelay = arrivalTime - captureTime
    this.transitPairs.push([captureTime, rawDelay])

    const dueAt = this._dueAt(captureTime, arrivalTime)
    const stored = { sequence: extended, captureTime, arrivalTime, dueAt, payload: frame.payload }

    let discarded = null
    if (this.buffer.size >= this.options.maxBufferedFrames) {
      const oldestKey = this.buffer.keys().next().value
      const oldest = this.buffer.get(oldestKey)
      this.buffer.delete(oldestKey)
      discarded = {
        sequence: oldest.sequence,
        reason: 'buffer-overflow',
        arrivalTime: oldest.arrivalTime
      }
    }
    this.buffer.set(extended, stored)
    return { accepted: true, reason: 'buffered', sequence: extended, discarded }
  }

  tick(now) {
    if (!Number.isFinite(now)) {
      throw new TypeError('tick(now) 需要外部显式传入有限的时间值')
    }
    if (this.lastTickTime !== null && now < this.lastTickTime) {
      throw new RangeError('播放时间只能单调递增')
    }
    this.lastTickTime = now
    this._updateTargetDelay(now)

    const discards = this._sweepExpired(now)

    if (!this.primed) {
      if (this.buffer.size === 0) {
        const reason = this.needResync
          ? (this.resyncReason ?? 'rebuffering')
          : 'priming-empty'
        return this._decision(ACTION.WAIT, reason, now, { discards })
      }
      const first = this.buffer.get(this.buffer.keys().next().value)
      if (first.dueAt > now) {
        const reason = this.needResync ? (this.resyncReason ?? 'rebuffering') : 'priming'
        return this._decision(ACTION.WAIT, reason, now, { discards })
      }
      this.primed = true
      this.needResync = false
      this.resyncReason = null
      this.missedSince = null
    }

    const earliestKey =
      this.buffer.size === 0 ? null : this.buffer.keys().next().value
    if (earliestKey !== this.nextSequence) {
      return this._handleGap(now, earliestKey, discards)
    }

    if (this.buffer.size === 0) {
      this.missedSince = null
      return this._decision(ACTION.WAIT, 'empty-buffer', now, { discards })
    }

    const frame = this.buffer.get(earliestKey)
    if (frame.dueAt > now) {
      this.missedSince = null
      this.consecutiveConcealed = 0
      return this._decision(ACTION.WAIT, 'awaiting-playout-time', now, { discards })
    }

    this.buffer.delete(earliestKey)
    this.playedUpTo = earliestKey
    this.nextSequence = earliestKey + 1
    this.missedSince = null
    this.consecutiveConcealed = 0
    return this._decision(ACTION.PLAY, 'frame-due', now, { frame, discards })
  }

  getStats() {
    return {
      targetDelay: this.targetDelay,
      targetReason: this.targetReason,
      queuedFrames: this.buffer.size,
      highestExtendedSequence: this.highestExtendedSequence,
      nextSequence: this.nextSequence,
      driftSlope: this.driftSlope,
      playoutOffset: this.playoutOffset,
      consecutiveConcealed: this.consecutiveConcealed,
      primed: this.primed,
      resyncing: this.needResync
    }
  }

  _handleGap(now, earliestKey, discards) {
    const missingSequence = this.nextSequence
    if (this.missedSince === null) {
      this.missedSince = now
    }
    const waitedTicks = Math.round((now - this.missedSince) / this.options.tickMs)
    if (waitedTicks < this.options.lossConfirmTicks) {
      return this._decision(ACTION.WAIT, 'awaiting-reorder', now, {
        missingSequence,
        discards
      })
    }
    if (this.buffer.has(missingSequence)) {
      this.missedSince = null
      this.consecutiveConcealed = 0
      const frame = this.buffer.get(missingSequence)
      if (frame.dueAt > now) {
        return this._decision(ACTION.WAIT, 'awaiting-playout-time', now, { discards })
      }
      this.buffer.delete(missingSequence)
      this.playedUpTo = missingSequence
      this.nextSequence = missingSequence + 1
      return this._decision(ACTION.PLAY, 'recovered-out-of-order', now, { frame, discards })
    }

    this.playedUpTo = missingSequence
    this.nextSequence = missingSequence + 1
    this.missedSince = null
    this.consecutiveConcealed += 1

    if (this.consecutiveConcealed > this.options.maxConcealTicks) {
      this.consecutiveConcealed = 0
      if (earliestKey === null) {
        this.needResync = true
        this.primed = false
        this.resyncReason = 'rebuffering-permanent-loss'
        this.missedSince = null
        this.playoutOffset = null
      } else {
        this._rebufferAt(earliestKey, 'rebuffering-permanent-loss')
      }
      return this._decision(ACTION.WAIT, 'rebuffering-permanent-loss', now, {
        missingSequence,
        discards
      })
    }

    const action = this.consecutiveConcealed === 1 ? ACTION.REPEAT : ACTION.HIDE_LOSS
    const reason =
      this.consecutiveConcealed === 1 ? 'loss-confirmed-repeat' : 'loss-confirmed-hide'
    return this._decision(action, reason, now, { missingSequence, discards })
  }

  _rebufferAt(sequence, reason) {
    this.needResync = true
    this.primed = false
    this.resyncReason = reason
    this.nextSequence = sequence
    this.playedUpTo = sequence - 1
    this.missedSince = null
    this.consecutiveConcealed = 0
    this.playoutOffset = null
    this._recomputeDueTimes()
  }

  _handleInterruption() {
    this.buffer.clear()
    this.transitPairs.clear()
    this.driftSlope = 0
    this.holdTicks = 0
    this.targetDelay = this.options.minDelayMs
    this.targetReason = 'interruption-reset'
    this.consecutiveConcealed = 0
    this.missedSince = null
    this.primed = false
    this.playoutOffset = null
    this.needResync = true
    this.resyncReason = 'rebuffering-after-interrupt'
  }

  _sweepExpired(now) {
    const discards = []
    const limit = now - this.options.maxDelayMs
    while (this.buffer.size > 0) {
      const key = this.buffer.keys().next().value
      const frame = this.buffer.get(key)
      if (frame.dueAt >= limit) break
      this.buffer.delete(key)
      discards.push({
        sequence: frame.sequence,
        reason: 'expired-frame',
        arrivalTime: frame.arrivalTime
      })
      if (key > this.playedUpTo) {
        this.playedUpTo = key
        this.nextSequence = key + 1
      }
    }
    return discards
  }

  _updateTargetDelay(now) {
    const pairs = this.transitPairs.toArray()
    if (pairs.length < 2) {
      this.targetReason = 'insufficient-samples'
      return
    }
    const origin = pairs[0][0]
    const centered = pairs.map(([capture, raw]) => [capture - origin, raw])
    const filteredRaw = movingMedian(
      pairs.map(([, raw]) => raw),
      this.options.driftFilterWindow
    )
    const slope = this._clampDrift(
      leastSquaresSlope(centered.map(([offset], index) => [offset, filteredRaw[index]]))
    )
    this.driftSlope = slope
    const adjusted = centered.map(([offset, raw]) => raw - slope * offset)
    const jitterQuantile = quantile(adjusted, this.options.quantile)
    const desired = Math.min(
      this.options.maxDelayMs,
      Math.max(this.options.minDelayMs, jitterQuantile)
    )

    if (desired > this.targetDelay) {
      this.playoutOffset = this._shiftOffset(desired, now)
      this.targetDelay = desired
      this.holdTicks = 0
      this.targetReason = 'increase-fast'
      this._recomputeDueTimes()
    } else if (desired < this.targetDelay - this.options.hysteresisMs) {
      this.holdTicks += 1
      if (this.holdTicks >= this.options.decreaseHoldTicks) {
        this.playoutOffset = this._shiftOffset(desired, now)
        this.targetDelay = desired
        this.holdTicks = 0
        this.targetReason = 'decrease-slow'
        this._recomputeDueTimes()
      } else {
        this.targetReason = 'hold-hysteresis'
      }
    } else {
      this.holdTicks = 0
      this.targetReason = 'hold-in-band'
    }

    if (slope !== 0 && this.playoutOffset !== null && this.lastTickTime !== null) {
      this.playoutOffset += slope * this.options.tickMs
      this._recomputeDueTimes()
    }
  }

  _clampDrift(slope) {
    const limit = this.options.maxDriftRate
    return Math.max(-limit, Math.min(limit, slope))
  }

  _shiftOffset(nextTarget, now) {
    if (this.playoutOffset === null) return nextTarget
    const next = this.playoutOffset + (nextTarget - this.targetDelay)
    const lowerBound = this.options.minDelayMs
    const upperBound = now + this.options.maxDelayMs - this._earliestCapture()
    return Math.max(lowerBound, Math.min(upperBound, next))
  }

  _earliestCapture() {
    if (this.buffer.size === 0) return 0
    return this.buffer.get(this.buffer.keys().next().value).captureTime
  }

  _dueAt(captureTime, arrivalTime) {
    if (this.playoutOffset === null) {
      this.playoutOffset = this.targetDelay
    }
    return Math.max(arrivalTime, captureTime + this.playoutOffset)
  }

  _recomputeDueTimes() {
    for (const frame of this.buffer.values()) {
      frame.dueAt = Math.max(frame.arrivalTime, frame.captureTime + this.playoutOffset)
    }
  }

  _decision(action, reason, now, extra = {}) {
    const decision = {
      action,
      reason,
      now,
      targetDelay: this.targetDelay,
      queuedFrames: this.buffer.size
    }
    if (extra.frame) decision.frame = extra.frame
    if (extra.missingSequence !== undefined) decision.missingSequence = extra.missingSequence
    if (extra.discards && extra.discards.length > 0) decision.discards = extra.discards
    return decision
  }
}
