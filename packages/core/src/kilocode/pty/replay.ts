/** Bounded UTF-16 retention, independent of the backing storage of incoming strings. */
export class Replay {
  private readonly blocks: (Uint16Array | undefined)[]
  private readonly block = 4096
  private next = 0
  private size = 0

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 2 * 1024 * 1024)
      throw new Error("PTY replay retention limit invalid")
    this.blocks = Array.from({ length: Math.ceil(limit / this.block) }, () => undefined)
  }

  get length() {
    return this.size
  }

  get capacity() {
    return this.blocks.reduce((sum, block) => sum + (block?.length ?? 0), 0)
  }

  append(data: string) {
    const dropped = Math.max(0, this.size + data.length - this.limit)
    // Skip discarded prefixes without traversing or retaining their backing strings.
    let index = Math.max(0, data.length - this.limit)
    this.next = (this.next + index) % this.limit
    while (index < data.length) {
      const id = Math.floor(this.next / this.block)
      const offset = this.next % this.block
      const block = (this.blocks[id] ??= new Uint16Array(Math.min(this.block, this.limit - id * this.block)))
      const count = Math.min(data.length - index, block.length - offset)
      for (let n = 0; n < count; n++) block[offset + n] = data.charCodeAt(index + n)
      this.next = (this.next + count) % this.limit
      index += count
    }
    this.size = Math.min(this.limit, this.size + data.length)
    return dropped
  }

  slice(offset = 0) {
    const from = Math.min(this.size, Math.max(0, offset < 0 ? this.size + offset : offset))
    const result: string[] = []
    let next = (this.next - this.size + from + this.limit) % this.limit
    let left = this.size - from
    while (left > 0) {
      const block = this.blocks[Math.floor(next / this.block)]!
      const start = next % this.block
      const count = Math.min(left, block.length - start)
      result.push(String.fromCharCode(...block.subarray(start, start + count)))
      next = (next + count) % this.limit
      left -= count
    }
    return result.join("")
  }
}
