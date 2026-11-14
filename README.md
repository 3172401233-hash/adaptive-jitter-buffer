# adaptive-jitter-buffer

纯决策的 Node.js 语音抖动缓冲库。它**只负责决策**：输入带序号、采集时间和到达时间的语音帧以及固定播放 tick，输出每个 tick 应该执行的动作和 `reason`。库本身不接触编码器、音频设备、Socket 或系统时钟，因此可以在测试里用可控的虚拟时间完整驱动。

## 设计目标

- 目标延迟由近期单向传输延迟的分位数（默认 P90）决定。
- **增加延迟要快**：分位数一旦高于当前目标，立即上抬。
- **降低延迟要慢**：分位数持续低于目标并越过 hysteresis 带后，还要保持 `decreaseHoldTicks` 个 tick 才下调。
- **hysteresis 防抖**：目标值附近的小波动不会触发任何调整，避免目标延迟来回跳。
- 全部时间由调用方显式传入，库内部不调用 `Date.now()`、`setTimeout`、`Math.random()`，同一份输入在任何机器上结果完全一致。

## 安装与测试

```bash
npm test          # 等价于 node --test
node --test       # 直接运行内置测试运行器
```

无第三方运行时依赖，仅使用 Node.js 内置的 `node:test` 与 `node:assert`，要求 Node.js >= 18。

## 快速上手

```js
import { JitterBuffer, ACTION } from 'adaptive-jitter-buffer'

const jb = new JitterBuffer({
  tickMs: 20,        // 固定播放 tick
  minDelayMs: 40,    // 目标延迟下限
  maxDelayMs: 400    // 目标延迟与帧存活的硬上限
})

// 网络层收到帧时调用，时间单位自定义但必须全程一致（这里用毫秒）
jb.pushFrame({
  sequence: rtpSequence,   // 16 位序号，自动处理回绕
  captureTime,             // 发送端采集时间
  arrivalTime,             // 本地接收时间
  payload: encodedFrame    // 可选，库不解析
})

// 每个播放 tick 调用一次，now 为该 tick 的播放时间
const decision = jb.tick(now)
switch (decision.action) {
  case ACTION.PLAY:
    renderer.enqueue(decision.frame.payload)
    break
  case ACTION.REPEAT:
    renderer.repeatLastFrame()
    break
  case ACTION.HIDE_LOSS:
    renderer.conceal(decision.missingSequence)
    break
  case ACTION.WAIT:
    // 本 tick 不产出音频，reason 说明在等什么
    break
  case ACTION.DISCARD:
    // 过期或溢出帧，明细放在 decision.discards
    break
}
```

## 五种动作与 decision reason

`tick(now)` 返回的决策对象固定包含 `action`、`reason`、`now`、`targetDelay`、`queuedFrames`，并按场景附带 `frame`、`missingSequence` 或 `discards`。

| action | 含义 | 典型 reason |
| --- | --- | --- |
| `wait` | 本 tick 不产出帧 | `priming`、`priming-empty`、`awaiting-playout-time`、`awaiting-reorder`、`empty-buffer`、`rebuffering-after-interrupt`、`rebuffering-permanent-loss` |
| `play` | 播放到期帧 | `frame-due`、`recovered-out-of-order` |
| `repeat` | 重复上一帧（首个丢包） | `loss-confirmed-repeat` |
| `hide-loss` | 对连续丢失做丢包隐藏 | `loss-confirmed-hide` |
| `discard` | 丢弃过期/溢出帧 | `expired-frame`、`buffer-overflow` |

`pushFrame()` 自身也会返回 `{ accepted, reason }`，其中 `duplicate-frame` 表示重复包，`late-frame-already-played` 表示迟到且对应位置已经播放，`buffer-overflow` 时返回值的 `discarded` 字段给出被挤掉的最老帧。

## 丢包隐藏策略

库区分“可能只是乱序”和“确认丢失”，避免对迟到帧误隐藏：

1. 发现下一期望序号缺失时，先进入 `awaiting-reorder`，持续 `lossConfirmTicks` 个 tick（默认 2）。
2. 等待窗口内帧到达则正常播放（`recovered-out-of-order`），完全不产生隐藏。
3. 窗口结束仍缺失则**确认丢失**：
   - 第一次确认丢失输出 `repeat`（`loss-confirmed-repeat`），由播放层重复上一帧，这是听感最平滑的第一拍处理。
   - 之后连续丢失输出 `hide-loss`（`loss-confirmed-hide`），播放层可自行实现插值、舒适噪声或静音填充；库只负责给出缺失序号，不生成音频。
4. 连续隐藏计数 `consecutiveConcealed` 一旦超过 `maxConcealTicks`（默认 10），判定为**永久丢包/断流**，停止无限隐藏，进入 `rebuffering-permanent-loss` 重新建立缓冲，新帧到达并满足播放时刻后自动恢复。
5. 任意一帧真实播放都会把连续隐藏计数清零。

## 最大延迟（maxDelayMs）

`maxDelayMs`（默认 **400ms**）是库的硬延迟红线，在两处生效：

- **目标延迟上限**：无论 P90 抖动多大，`targetDelay` 都会被 clamp 到 `[minDelayMs, maxDelayMs]`，不会因为持续抖动无限抬高对话延迟。
- **帧存活上限**：每个 tick 开头执行过期清扫，`dueAt < now - maxDelayMs` 的帧从缓冲移除并以 `discards: [{ reason: 'expired-frame' }]` 上报。宁可丢帧也不播放超过红线的陈旧音频。

另有独立的内存红线 `maxBufferedFrames`（默认 200）：缓冲帧数达到上限时，新帧入队会挤掉最老帧并通过 `pushFrame` 返回值的 `discarded.reason = 'buffer-overflow'` 上报，保证内存占用有界。

## 目标延迟与时钟漂移

- 每帧记录单向传输延迟 `arrivalTime - captureTime`，保存在容量为 `statsWindow`（默认 128）的定长环形窗口中。
- 估计时钟漂移前先对传输延迟做滑动中位数滤波（`driftFilterWindow`，默认 9），把突发抖动和台阶式延迟跳变吸收掉，再做最小二乘线性拟合，避免把网络抖动误判成频偏。
- 拟合出的斜率按 `maxDriftRate`（默认 0.005，即 ±5000ppm，覆盖常见晶体偏差）clamp，并通过播放偏移在每个 tick 缓慢补偿，而不是直接改动目标延迟。
- 去漂移后的样本取 `quantile`（默认 0.9）分位数，再与 `minDelayMs/maxDelayMs` clamp 得到期望目标延迟。
- 播放时刻以 `captureTime + playoutOffset` 为基准（不早于 `arrivalTime`），因此同一时刻突发到达的一批帧会按各自采集间隔被摊平到连续 tick，而不是一次性挤在同一拍播放或被丢弃。

## 边界情况处理

- **重复包**：相同扩展序号或缓冲中已存在的帧直接拒绝，返回 `duplicate-frame`。
- **序号回绕**：按 RFC 3550 风格把 16 位序号展开为单调递增的扩展序号，跨 65535/0 边界连续播放。
- **乱序恢复**：丢失位置先等待 `lossConfirmTicks`，窗口内到达即按序恢复播放。
- **长时间断流**：相邻到达间隔超过 `interruptMs`（默认 2000ms）时清空缓冲与统计、目标延迟回到 `minDelayMs`，进入 `rebuffering-after-interrupt` 重新 priming。
- **时钟漂移**：中位数滤波 + 最小二乘 + 斜率 clamp + tick 级缓慢补偿。
- **突发到达**：基于采集时间的播放偏移把突发帧摊平到各自 tick。
- **永久丢包**：超过 `maxConcealTicks` 后停止隐藏并重新缓冲。
- **资源上限**：`maxBufferedFrames` 限制队列长度，`statsWindow` 限制统计内存，全部容器均为定长结构。

## 配置项

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `tickMs` | 20 | 固定播放 tick 长度，也用于丢包确认 tick 计数 |
| `minDelayMs` | 40 | 目标延迟下限 |
| `maxDelayMs` | 400 | 目标延迟与帧存活的硬上限 |
| `quantile` | 0.9 | 抖动分位数 |
| `hysteresisMs` | 30 | 下调目标前需越过的滞后带 |
| `decreaseHoldTicks` | 25 | 满足下调条件后仍需保持的 tick 数 |
| `lossConfirmTicks` | 2 | 判定丢失前给乱序恢复预留的 tick 数 |
| `maxConcealTicks` | 10 | 连续隐藏上限，超过即重新缓冲 |
| `interruptMs` | 2000 | 相邻帧到达间隔超过该值视为断流 |
| `maxBufferedFrames` | 200 | 缓冲帧数量硬上限 |
| `statsWindow` | 128 | 抖动/漂移统计环形窗口容量 |
| `maxDriftRate` | 0.005 | 允许补偿的最大相对频率偏差 |
| `driftFilterWindow` | 9 | 漂移拟合前的滑动中位数窗口 |

可通过 `getStats()` 读取 `targetDelay`、`targetReason`、`queuedFrames`、`nextSequence`、`driftSlope`、`playoutOffset`、`consecutiveConcealed`、`primed`、`resyncing` 等运行时状态。

## 测试策略

所有测试都用**手动推进的虚拟时间**驱动，不使用系统 `sleep`：

- 乱序恢复与重复包、迟到帧拒绝。
- 目标延迟的快增、慢降与 hysteresis 收敛。
- 正常流与突发到达的播放连续性。
- 丢包确认、重复帧、隐藏、永久丢包重缓冲及恢复。
- `maxBufferedFrames` 溢出与 `maxDelayMs` 过期清理的资源上限。
- 65535 序号回绕、长时间断流、线性时钟漂移。
- 两个独立实例跑相同输入的逐 tick 决策深度相等，验证结果确定性。

## 目录结构

```
src/
  index.js          公共导出
  jitter-buffer.js  决策状态机与自适应目标延迟
  sequence.js       16 位序号展开与回绕距离
  ring-buffer.js    定长环形样本窗口
  stats.js          分位数、最小二乘、滑动中位数
test/
  jitter-buffer.test.js
```
