import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ACTION, DEFAULT_OPTIONS, JitterBuffer } from '../src/index.js'
import { extendSequence, quantile, seqDistance } from '../src/index.js'

function makeFrame(sequence, arrivalTime, options = {}) {
  const captureTime = options.captureTime ?? arrivalTime - 100
  return {
    sequence,
    captureTime,
    arrivalTime,
    payload: options.payload ?? { pcm: sequence }
  }
}

function runTicks(jb, start, count, tickMs = 20) {
  const decisions = []
  for (let i = 1; i <= count; i += 1) {
    decisions.push(jb.tick(start + i * tickMs))
  }
  return decisions
}

function playDecisions(decisions) {
  return decisions.filter((d) => d.action === ACTION.PLAY)
}

describe('序号工具：回绕与距离', () => {
  it('跨 65535 边界展开为连续递增序号', () => {
    let prev = 65534
    prev = extendSequence(prev, 65535)
    assert.equal(prev, 65535)
    prev = extendSequence(prev, 0)
    assert.equal(prev, 65536)
    prev = extendSequence(prev, 1)
    assert.equal(prev, 65537)
  })

  it('seqDistance 在回绕空间内给出有符号距离', () => {
    assert.equal(seqDistance(0, 65535), 1)
    assert.equal(seqDistance(65535, 0), -1)
    assert.equal(seqDistance(100, 90), 10)
  })

  it('分位数无插值且确定', () => {
    const samples = [9, 1, 5, 7, 3]
    assert.equal(quantile(samples, 0.9), 9)
    assert.deepEqual(samples, [9, 1, 5, 7, 3])
  })
})

describe('乱序恢复', () => {
  it('短时间内等待乱序帧，帧到齐后按序号连续播放', () => {
    const jb = new JitterBuffer({ minDelayMs: 40, maxDelayMs: 300 })
    jb.pushFrame(makeFrame(0, 1000, { captureTime: 900 }))
    jb.pushFrame(makeFrame(2, 1040, { captureTime: 940 }))
    jb.pushFrame(makeFrame(1, 1060, { captureTime: 920 }))

    const decisions = runTicks(jb, 1000, 12)
    const waits = decisions.filter((d) => d.action === ACTION.WAIT)
    const plays = playDecisions(decisions)
    assert.ok(waits.some((d) => d.reason === 'priming' || d.reason === 'awaiting-reorder'))
    assert.deepEqual(plays.map((d) => d.frame.sequence), [0, 1, 2])
  })

  it('重复包被拒绝，不会产生第二个缓冲帧', () => {
    const jb = new JitterBuffer()
    jb.pushFrame(makeFrame(0, 1000))
    const first = jb.pushFrame(makeFrame(0, 1001))
    const second = jb.pushFrame(makeFrame(0, 1002))
    assert.equal(first.accepted, false)
    assert.equal(first.reason, 'duplicate-frame')
    assert.equal(second.reason, 'duplicate-frame')
    assert.equal(jb.getStats().queuedFrames, 1)
  })

  it('播放完成后迟到的旧帧被拒绝', () => {
    const jb = new JitterBuffer({ minDelayMs: 20, maxDelayMs: 100 })
    for (let seq = 0; seq <= 3; seq += 1) {
      const arrival = 1000 + seq * 20
      jb.pushFrame(makeFrame(seq, arrival, { captureTime: arrival - 50 }))
    }
    runTicks(jb, 1000, 6)
    const late = jb.pushFrame(makeFrame(0, 1200, { captureTime: 950 }))
    assert.equal(late.accepted, false)
    assert.equal(late.reason, 'late-frame-already-played')
  })
})

describe('目标延迟收敛：快增、慢降与 hysteresis', () => {
  it('抖动突增时目标延迟立即上抬', () => {
    const jb = new JitterBuffer({
      minDelayMs: 20,
      maxDelayMs: 500,
      quantile: 0.9,
      hysteresisMs: 30
    })
    for (let seq = 0; seq < 30; seq += 1) {
      const capture = 1000 + seq * 20
      const jitter = seq >= 10 ? 220 : 40
      jb.pushFrame(makeFrame(seq, capture + jitter, { captureTime: capture }))
    }
    jb.tick(2000)
    const stats = jb.getStats()
    assert.ok(stats.targetDelay >= 200, `目标延迟应快速上抬，实际 ${stats.targetDelay}`)
    assert.equal(stats.targetReason, 'increase-fast')
  })

  it('抖动回落时必须持续多个 tick 才下调，且小波动被 hysteresis 吸收', () => {
    const captureAt = (seq) => 1000 + seq * 20
    const decreaseHoldTicks = 5
    const jb = new JitterBuffer({
      minDelayMs: 20,
      maxDelayMs: 500,
      hysteresisMs: 60,
      decreaseHoldTicks,
      statsWindow: 64
    })
    for (let seq = 0; seq < 40; seq += 1) {
      const capture = captureAt(seq)
      const jitter = seq % 4 === 0 ? 260 : 220
      jb.pushFrame(makeFrame(seq, capture + jitter, { captureTime: capture }))
    }
    jb.tick(2000)
    const high = jb.getStats().targetDelay
    assert.ok(high > 200)

    for (let seq = 40; seq < 110; seq += 1) {
      const capture = captureAt(seq)
      const jitter = seq % 4 === 0 ? 50 : 30
      jb.pushFrame(makeFrame(seq, capture + jitter, { captureTime: capture }))
    }

    let now = 3400
    const reasons = []
    while (jb.getStats().targetDelay === high && reasons.length < 20) {
      jb.tick(now)
      reasons.push(jb.getStats().targetReason)
      now += 20
    }
    assert.ok(reasons.includes('hold-hysteresis'))
    const holds = reasons.filter((reason) => reason === 'hold-hysteresis').length
    assert.ok(holds >= decreaseHoldTicks - 1, `慢降前必须连续保持多个 tick，实际 ${holds}`)
    assert.equal(jb.getStats().targetReason, 'decrease-slow')
    assert.ok(jb.getStats().targetDelay < high)
  })

  it('目标延迟始终不超过 maxDelayMs', () => {
    const jb = new JitterBuffer({ minDelayMs: 20, maxDelayMs: 160 })
    for (let seq = 0; seq < 30; seq += 1) {
      const capture = 1000 + seq * 20
      jb.pushFrame(makeFrame(seq, capture + 900, { captureTime: capture }))
    }
    jb.tick(2000)
    assert.equal(jb.getStats().targetDelay, 160)
  })
})

describe('播放连续性', () => {
  it('正常流在足够长时间后每个 tick 恰好输出一帧', () => {
    const jb = new JitterBuffer({ minDelayMs: 40, maxDelayMs: 200 })
    for (let seq = 0; seq < 60; seq += 1) {
      const capture = 1000 + seq * 20
      jb.pushFrame(makeFrame(seq, capture + 60, { captureTime: capture }))
    }
    const decisions = runTicks(jb, 1000, 55)
    const steady = decisions.slice(10)
    assert.ok(playDecisions(steady).length >= 40)
    const sequences = playDecisions(decisions).map((d) => d.frame.sequence)
    for (let i = 1; i < sequences.length; i += 1) {
      assert.equal(sequences[i], sequences[i - 1] + 1)
    }
  })

  it('突发到达的帧被摊平到各自 tick，而不是一次性丢弃', () => {
    const jb = new JitterBuffer({ minDelayMs: 40, maxDelayMs: 300 })
    const burstAt = 1500
    for (let seq = 0; seq < 10; seq += 1) {
      jb.pushFrame(makeFrame(seq, burstAt, { captureTime: 1000 + seq * 20 }))
    }
    const decisions = runTicks(jb, burstAt, 16)
    const discards = decisions.flatMap((d) => d.discards ?? [])
    assert.equal(discards.length, 0)
    const sequences = playDecisions(decisions).map((d) => d.frame.sequence)
    assert.deepEqual(sequences, [...sequences.keys()])
    assert.ok(sequences.length >= 8)
  })

  it('确认丢包先重复上一帧，连续丢失再进入隐藏，超过上限重新缓冲', () => {
    const jb = new JitterBuffer({
      minDelayMs: 10,
      maxDelayMs: 120,
      lossConfirmTicks: 1,
      maxConcealTicks: 3
    })
    for (let seq = 0; seq <= 4; seq += 1) {
      const arrival = 1000 + seq * 20
      jb.pushFrame(makeFrame(seq, arrival, { captureTime: arrival - 10 }))
    }
    const decisions = runTicks(jb, 1000, 24)
    const actions = decisions.map((d) => d.action)
    assert.ok(actions.includes(ACTION.REPEAT))
    assert.ok(actions.includes(ACTION.HIDE_LOSS))
    assert.ok(decisions.some((d) => d.reason === 'rebuffering-permanent-loss'))

    for (let seq = 5; seq < 12; seq += 1) {
      const arrival = 1500 + seq * 20
      jb.pushFrame(makeFrame(seq, arrival, { captureTime: arrival - 10 }))
    }
    const recovered = runTicks(jb, 1480, 12)
    assert.ok(playDecisions(recovered).length >= 5)
    assert.equal(jb.getStats().resyncing, false)
  })
})

describe('资源上限', () => {
  it('缓冲帧数超过 maxBufferedFrames 时丢弃最老帧并通过 push 结果上报', () => {
    const jb = new JitterBuffer({ maxBufferedFrames: 8, minDelayMs: 20 })
    let overflow
    for (let seq = 0; seq < 12; seq += 1) {
      const result = jb.pushFrame(makeFrame(seq, 1000 + seq, { captureTime: 900 + seq }))
      if (result.discarded) overflow = result.discarded
    }
    assert.ok(overflow)
    assert.equal(overflow.reason, 'buffer-overflow')
    assert.ok(overflow.sequence < 12)
    assert.equal(jb.getStats().queuedFrames, 8)
  })

  it('超过最大延迟仍未播放的过期帧在 tick 中被清理', () => {
    const jb = new JitterBuffer({
      minDelayMs: 20,
      maxDelayMs: 100,
      maxBufferedFrames: 50
    })
    for (let seq = 0; seq < 10; seq += 1) {
      jb.pushFrame(makeFrame(seq, 1000 + seq * 20, { captureTime: 900 + seq * 20 }))
    }
    const decision = jb.tick(3000)
    assert.ok(decision.discards)
    assert.ok(decision.discards.every((d) => d.reason === 'expired-frame'))
  })
})

describe('断流、漂移与确定性', () => {
  it('序号从 65535 回绕到 0 后仍连续播放', () => {
    const jb = new JitterBuffer({ minDelayMs: 20, maxDelayMs: 120 })
    const seqs = [65533, 65534, 65535, 0, 1, 2]
    for (const seq of seqs) {
      const arrival = 1000 + ((seq + 3) % 65536) * 20
      jb.pushFrame(makeFrame(seq, arrival, { captureTime: arrival - 30 }))
    }
    const decisions = runTicks(jb, 1000, 12)
    const played = playDecisions(decisions).map((d) => d.frame.sequence)
    assert.deepEqual(played, [65533, 65534, 65535, 65536, 65537, 65538])
  })

  it('长时间断流后清空统计并重新 priming', () => {
    const jb = new JitterBuffer({ minDelayMs: 40, interruptMs: 500 })
    for (let seq = 0; seq < 10; seq += 1) {
      const arrival = 1000 + seq * 20
      jb.pushFrame(makeFrame(seq, arrival, { captureTime: arrival - 50 }))
    }
    runTicks(jb, 1000, 12)
    const afterGap = jb.pushFrame(makeFrame(20, 3000, { captureTime: 2900 }))
    assert.equal(afterGap.accepted, true)
    const decision = jb.tick(2980)
    assert.equal(decision.action, ACTION.WAIT)
    assert.equal(decision.reason, 'rebuffering-after-interrupt')
    assert.equal(jb.getStats().targetDelay, DEFAULT_OPTIONS.minDelayMs)

    for (let seq = 21; seq < 26; seq += 1) {
      const arrival = 3040 + (seq - 21) * 20
      jb.pushFrame(makeFrame(seq, arrival, { captureTime: arrival - 50 }))
    }
    const resumed = runTicks(jb, 3020, 12)
    assert.ok(playDecisions(resumed).length >= 4)
  })

  it('线性时钟漂移不会让目标延迟无限增长', () => {
    const driftPerFrame = 0.05
    const jb = new JitterBuffer({
      minDelayMs: 20,
      maxDelayMs: 400,
      quantile: 0.9,
      statsWindow: 128
    })
    for (let seq = 0; seq < 120; seq += 1) {
      const capture = 1000 + seq * 20
      const arrival = capture + 60 + driftPerFrame * seq
      jb.pushFrame(makeFrame(seq, arrival, { captureTime: capture }))
    }
    jb.tick(4000)
    const stats = jb.getStats()
    assert.ok(Math.abs(stats.driftSlope) > 0)
    assert.ok(stats.targetDelay <= 120, `漂移被补偿后目标延迟应稳定，实际 ${stats.targetDelay}`)
  })

  it('相同输入在两个实例上产生逐 tick 完全一致的决策', () => {
    const build = () => {
      const jb = new JitterBuffer({ minDelayMs: 40, maxDelayMs: 260, statsWindow: 32 })
      const log = []
      for (let seq = 0; seq < 40; seq += 1) {
        const capture = 1000 + seq * 20
        const jitter = [20, 120, 40, 200, 60][seq % 5]
        jb.pushFrame(makeFrame(seq, capture + jitter, { captureTime: capture }))
      }
      for (let tick = 1; tick <= 40; tick += 1) {
        log.push(jb.tick(1000 + tick * 20))
      }
      return log
    }
    assert.deepEqual(build(), build())
  })

  it('非法参数与非法时间输入立即抛错', () => {
    assert.throws(() => new JitterBuffer({ maxDelayMs: 10, minDelayMs: 40 }), RangeError)
    const jb = new JitterBuffer()
    assert.throws(() => jb.tick(NaN), TypeError)
    jb.tick(1000)
    assert.throws(() => jb.tick(999), RangeError)
    assert.throws(
      () => jb.pushFrame({ sequence: 1, captureTime: 100, arrivalTime: 50 }),
      RangeError
    )
  })
})
