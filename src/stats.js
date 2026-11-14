/**
 * 最近秩（nearest-rank）分位数，输入会被复制后排序，不改动原数组。
 * 无插值，保证同一份输入在任何平台上得到完全一致的结果。
 */
export function quantile(samples, q) {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil(q * sorted.length))
  return sorted[Math.min(rank, sorted.length) - 1]
}

/**
 * 对 (x, y) 样本做最小二乘线性拟合，返回斜率。
 * 这里 x 为采集时间、y 为单向传输时间，斜率即收发两端的相对频率偏差：
 * 斜率持续为正表示接收端时钟相对发送端偏慢，反之偏快。
 */
export function leastSquaresSlope(samples) {
  const n = samples.length
  if (n < 2) return 0
  let sumX = 0
  let sumY = 0
  for (const [x, y] of samples) {
    sumX += x
    sumY += y
  }
  const meanX = sumX / n
  const meanY = sumY / n
  let numerator = 0
  let denominator = 0
  for (const [x, y] of samples) {
    const dx = x - meanX
    numerator += dx * (y - meanY)
    denominator += dx * dx
  }
  if (denominator === 0) return 0
  return numerator / denominator
}

/**
 * 中位数绝对偏差（MAD）的中位数，用于量化去趋势后残差的离散程度。
 */
export function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * 对有序时间序列做滑动中位数滤波，窗口长度自动取最近的奇数。
 * 突发抖动和台阶式延迟跳变会被中位数吸收，避免被误判成时钟漂移。
 */
export function movingMedian(values, windowSize) {
  const size = Math.min(windowSize, values.length)
  const radius = Math.floor(size / 2)
  return values.map((_, index) => {
    const start = Math.max(0, index - radius)
    const end = Math.min(values.length, index + radius + 1)
    return median(values.slice(start, end))
  })
}
