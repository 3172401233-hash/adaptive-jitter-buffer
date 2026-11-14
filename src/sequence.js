export const SEQ_MOD = 1 << 16

/**
 * 把 16 位序号展开为单调递增的扩展序号。
 * 依据 RFC 3550 的规则：落在前一个序号前后半个回绕空间内的新序号，
 * 被视为连续，跨越 0/65535 边界时自动加减 65536。
 *
 * @param {number} previous 已展开的上一个序号
 * @param {number} seq 新到达的 16 位序号
 * @returns {number} 展开后的序号
 */
export function extendSequence(previous, seq) {
  const forward = ((seq - previous) % SEQ_MOD + SEQ_MOD) % SEQ_MOD
  if (forward === 0) return previous
  if (forward < SEQ_MOD / 2) return previous + forward
  return previous - (SEQ_MOD - forward)
}

/**
 * 有符号的回绕安全距离：a - b，结果落在 [-32768, 32767]。
 */
export function seqDistance(a, b) {
  const delta = (a - b) % SEQ_MOD
  if (delta > SEQ_MOD / 2 - 1) return delta - SEQ_MOD
  if (delta < -SEQ_MOD / 2) return delta + SEQ_MOD
  return delta
}
