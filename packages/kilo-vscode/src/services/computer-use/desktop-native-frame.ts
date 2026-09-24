import { CAPTURE } from "./desktop-session"

const HEADER = 4_096
const LIMIT = HEADER + CAPTURE.bytes + 8
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const UTF8 = new TextDecoder("utf-8", { fatal: true })

export type NativeFrame = {
  sequence: number
  windowID: string
  location: string
  width: number
  height: number
  mime: "image/png" | "image/jpeg"
  acquisitionMs: number
  preparationMs: number
  data: Buffer
}

export type NativeUnchanged = Pick<NativeFrame, "sequence" | "windowID" | "location" | "width" | "height"> & {
  base: number
}

type NativePacket =
  | { type: "frame"; frame: NativeFrame }
  | { type: "unchanged"; frame: NativeUnchanged }
  | { type: "error"; code: string; fault?: string }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Native desktop header is invalid")
  return value as Record<string, unknown>
}

function number(value: unknown, name: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum)
    throw new Error(`Native desktop ${name} is invalid`)
  return value
}

function dimensions(value: Record<string, unknown>) {
  const sequence = number(value.sequence, "sequence", Number.MAX_SAFE_INTEGER)
  const width = number(value.width, "width", CAPTURE.edge)
  const height = number(value.height, "height", CAPTURE.edge)
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    !Number.isInteger(width) ||
    width < 1 ||
    !Number.isInteger(height) ||
    height < 1 ||
    width * height > CAPTURE.pixels
  )
    throw new Error("Native desktop frame dimensions or sequence are invalid")
  return { sequence, width, height }
}

function identity(value: Record<string, unknown>) {
  if (typeof value.windowID !== "string" || !/^0x[0-9A-F]+$/.test(value.windowID))
    throw new Error("Native desktop window identity is invalid")
  if (
    typeof value.location !== "string" ||
    value.location.length > HEADER ||
    !/^pid:\d+;title:[\s\S]*;bounds:-?\d+,-?\d+,\d+,\d+$/.test(value.location)
  )
    throw new Error("Native desktop location is invalid")
  return { windowID: value.windowID, location: value.location }
}

function image(value: Record<string, unknown>, data: Buffer) {
  if (value.mime !== "image/png" && value.mime !== "image/jpeg") throw new Error("Native desktop image type is invalid")
  if (!data.length || data.length > CAPTURE.bytes) throw new Error("Native desktop image length is invalid")
  if (value.mime === "image/png" && !data.subarray(0, PNG.length).equals(PNG))
    throw new Error("Native desktop PNG signature is invalid")
  if (
    value.mime === "image/jpeg" &&
    (data[0] !== 0xff || data[1] !== 0xd8 || data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9)
  )
    throw new Error("Native desktop JPEG signature is invalid")
  return { mime: value.mime as NativeFrame["mime"], data }
}

function packet(header: unknown, data: Buffer): NativePacket {
  const value = record(header)
  if (value.v !== 1) throw new Error("Native desktop protocol version is unsupported")
  if (value.type === "error") {
    if (data.length || typeof value.code !== "string" || !/^[a-z_]{1,64}$/.test(value.code))
      throw new Error("Native desktop error packet is invalid")
    if (value.code === "native_fault") {
      if (typeof value.fault !== "string" || !/^[0-9A-F]{8}:[A-Za-z0-9_.-]{1,48}\+0x[0-9A-F]{1,16}$/.test(value.fault))
        throw new Error("Native desktop fault receipt is invalid")
      return { type: "error", code: value.code, fault: value.fault }
    }
    if (value.fault !== undefined) throw new Error("Native desktop fault receipt is unexpected")
    return { type: "error", code: value.code }
  }
  if (value.type === "unchanged") {
    if (data.length) throw new Error("Native desktop unchanged packet contains an image")
    const frame = {
      ...dimensions(value),
      ...identity(value),
      base: number(value.base, "base", Number.MAX_SAFE_INTEGER),
    }
    if (!Number.isSafeInteger(frame.base) || frame.base < 1 || frame.base >= frame.sequence)
      throw new Error("Native desktop unchanged base is invalid")
    return { type: "unchanged", frame }
  }
  if (value.type !== "frame") throw new Error("Native desktop packet type is invalid")
  return {
    type: "frame",
    frame: {
      ...dimensions(value),
      ...identity(value),
      ...image(value, data),
      acquisitionMs: number(value.acquisitionMs, "acquisition timing", 120_000),
      preparationMs: number(value.preparationMs, "preparation timing", 120_000),
    },
  }
}

export class NativeFrameParser {
  private readonly bytes = Buffer.allocUnsafe(LIMIT)
  private size = 0
  private sequence = 0
  private image?: Pick<NativeFrame, "sequence" | "windowID" | "location" | "width" | "height">
  private failed = false

  push(chunk: Buffer): NativePacket[] {
    if (this.failed) throw new Error("Native desktop stream already failed")
    const packets: NativePacket[] = []
    try {
      let offset = 0
      while (offset < chunk.length) {
        const need = this.expected()
        const count = Math.min(chunk.length - offset, need - this.size)
        chunk.copy(this.bytes, this.size, offset, offset + count)
        this.size += count
        offset += count
        if (this.size !== need) continue
        if (this.size === 4) {
          this.expected()
          continue
        }
        if (this.size < 8) continue
        const headerSize = this.bytes.readUInt32LE(0)
        if (this.size === 4 + headerSize + 4) {
          const length = this.bytes.readUInt32LE(4 + headerSize)
          if (length > CAPTURE.bytes) throw new Error("Native desktop image exceeds the byte limit")
          if (length) continue
        }
        if (this.size !== 8 + headerSize + this.bytes.readUInt32LE(4 + headerSize)) continue
        const header = JSON.parse(UTF8.decode(this.bytes.subarray(4, 4 + headerSize))) as unknown
        const data = Buffer.from(this.bytes.subarray(8 + headerSize, this.size))
        const result = packet(header, data)
        this.accept(result)
        packets.push(result)
        this.size = 0
        if (result.type === "error") {
          if (offset !== chunk.length) throw new Error("Native desktop error packet was followed by unexpected data")
          this.failed = true
          this.bytes.fill(0)
          return packets
        }
      }
      return packets
    } catch (error) {
      this.failed = true
      this.bytes.fill(0)
      throw error
    }
  }

  finish(): void {
    if (this.size) {
      this.failed = true
      this.bytes.fill(0)
      throw new Error("Native desktop stream ended with a partial packet")
    }
  }

  clear(): void {
    this.failed = true
    this.size = 0
    this.image = undefined
    this.bytes.fill(0)
  }

  private accept(result: NativePacket): void {
    if (result.type === "error") return
    const frame = result.frame
    if (frame.sequence <= this.sequence) throw new Error("Native desktop frame sequence replayed")
    if (result.type === "unchanged") {
      if (!this.image || result.frame.base !== this.image.sequence)
        throw new Error("Native desktop unchanged packet has no matching base image")
      if (
        frame.windowID !== this.image.windowID ||
        frame.location !== this.image.location ||
        frame.width !== this.image.width ||
        frame.height !== this.image.height
      )
        throw new Error("Native desktop unchanged target differs from the base image")
    }
    this.sequence = frame.sequence
    if (result.type === "frame")
      this.image = {
        sequence: frame.sequence,
        windowID: frame.windowID,
        location: frame.location,
        width: frame.width,
        height: frame.height,
      }
  }

  private expected(): number {
    if (this.size < 4) return 4
    const headerSize = this.bytes.readUInt32LE(0)
    if (headerSize < 1 || headerSize > HEADER) throw new Error("Native desktop header exceeds the byte limit")
    if (this.size < 4 + headerSize + 4) return 4 + headerSize + 4
    const length = this.bytes.readUInt32LE(4 + headerSize)
    if (length > CAPTURE.bytes) throw new Error("Native desktop image exceeds the byte limit")
    return 8 + headerSize + length
  }
}
