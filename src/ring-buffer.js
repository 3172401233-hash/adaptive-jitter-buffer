/**
 * 固定容量的环形样本窗口，保证统计窗口与内存占用都有上限。
 * 容量为 0 时退化为空窗口，所有写入都会被忽略。
 */
export class RingBuffer {
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new RangeError('capacity 必须为非负整数')
    }
    this.capacity = capacity
    this.items = new Array(capacity)
    this.head = 0
    this.size = 0
  }

  push(value) {
    if (this.capacity === 0) return
    this.items[this.head] = value
    this.head = (this.head + 1) % this.capacity
    if (this.size < this.capacity) this.size += 1
  }

  get length() {
    return this.size
  }

  /**
   * 按写入时间从旧到新返回快照，避免外部代码依赖内部环形下标。
   */
  toArray() {
    if (this.size === 0) return []
    const start = this.size < this.capacity ? 0 : this.head
    const result = new Array(this.size)
    for (let i = 0; i < this.size; i += 1) {
      result[i] = this.items[(start + i) % this.capacity]
    }
    return result
  }

  clear() {
    this.head = 0
    this.size = 0
  }
}
