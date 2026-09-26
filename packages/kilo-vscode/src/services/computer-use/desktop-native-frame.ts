import { CAPTURE } from "./desktop-session"

const HEADER = 4_096
const LIMIT = HEADER + CAPTURE.bytes + 8
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const UTF8 = new TextDecoder("utf-8", { fatal: true })

export type NativeFrame = {
  sequence: number
  epoch?: number
  identity?: string
  windowID: string
  location: string
  width: number
  height: number
  mime: "image/png" | "image/jpeg"
  acquisitionMs: number
  preparationMs: number
  data: Buffer
  barrier?: NativeProof
}

export type NativeProof = {
  request: string
  scene: number
  source: number
  receiptQpc: string
  presentQpc: string
}

export type NativeBarrier = Omit<NativeProof, "presentQpc"> & {
  status: "unproven"
  reason: "multiple_outputs" | "target_changed" | "source_changed" | "stale_scene" | "no_present" | "superseded"
}

export type NativeUnchanged = Pick<NativeFrame, "sequence" | "windowID" | "location" | "width" | "height"> & {
  base: number
  epoch?: number
  identity?: string
}

export type NativeReset = { epoch: number; reason: "target_changed" | "display_changed" }

export type NativePacket =
  | { type: "frame"; frame: NativeFrame }
  | { type: "unchanged"; frame: NativeUnchanged }
  | { type: "barrier"; barrier: NativeBarrier }
  | { type: "reset"; reset: NativeReset }
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

function fingerprint(value: Record<string, unknown>) {
  if (value.v !== 3 || value.identity === undefined) return {}
  if (typeof value.identity !== "string" || !/^[0-9A-F]{64}$/.test(value.identity))
    throw new Error("Native desktop process identity is invalid")
  return { identity: value.identity }
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

function receipt(value: Record<string, unknown>) {
  if (typeof value.request !== "string" || !/^[0-9a-f]{32}$/.test(value.request))
    throw new Error("Native desktop barrier request is invalid")
  const scene = number(value.scene, "barrier scene", Number.MAX_SAFE_INTEGER)
  const source = number(value.source, "barrier source", Number.MAX_SAFE_INTEGER)
  if (!Number.isSafeInteger(scene) || scene < 1 || !Number.isSafeInteger(source) || source < 1)
    throw new Error("Native desktop barrier scene or source is invalid")
  if (typeof value.receiptQpc !== "string" || !/^[1-9]\d{0,18}$/.test(value.receiptQpc))
    throw new Error("Native desktop barrier QPC receipt is invalid")
  return { request: value.request, scene, source, receiptQpc: value.receiptQpc }
}

function refusal(value: Record<string, unknown>, data: Buffer): NativePacket {
  if (
    value.v !== 2 ||
    data.length ||
    value.status !== "unproven" ||
    !["multiple_outputs", "target_changed", "source_changed", "stale_scene", "no_present", "superseded"].includes(
      String(value.reason),
    )
  )
    throw new Error("Native desktop barrier refusal is invalid")
  return {
    type: "barrier",
    barrier: { ...receipt(value), status: "unproven", reason: value.reason as NativeBarrier["reason"] },
  }
}

function failure(value: Record<string, unknown>, data: Buffer): NativePacket {
  if (value.v !== 1 || data.length || typeof value.code !== "string" || !/^[a-z_]{1,64}$/.test(value.code))
    throw new Error("Native desktop error packet is invalid")
  if (value.code === "native_fault") {
    if (typeof value.fault !== "string" || !/^[0-9A-F]{8}:[A-Za-z0-9_.-]{1,48}\+0x[0-9A-F]{1,16}$/.test(value.fault))
      throw new Error("Native desktop fault receipt is invalid")
    return { type: "error", code: value.code, fault: value.fault }
  }
  if (value.fault !== undefined) throw new Error("Native desktop fault receipt is unexpected")
  return { type: "error", code: value.code }
}

function unchanged(value: Record<string, unknown>, data: Buffer): NativePacket {
  if (value.v !== 1 && value.v !== 3) throw new Error("Native desktop unchanged protocol version is invalid")
  if (data.length) throw new Error("Native desktop unchanged packet contains an image")
  const frame = {
    ...dimensions(value),
    ...identity(value),
    ...fingerprint(value),
    base: number(value.base, "base", Number.MAX_SAFE_INTEGER),
    ...(value.v === 3 ? { epoch: generation(value) } : {}),
  }
  if (!Number.isSafeInteger(frame.base) || frame.base < 1 || frame.base >= frame.sequence)
    throw new Error("Native desktop unchanged base is invalid")
  return { type: "unchanged", frame }
}

function pixels(value: Record<string, unknown>, data: Buffer): NativePacket {
  const proof =
    value.v === 2 || (value.v === 3 && value.request !== undefined)
      ? (() => {
          const result = receipt(value)
          if (
            typeof value.presentQpc !== "string" ||
            !/^[1-9]\d{0,18}$/.test(value.presentQpc) ||
            BigInt(value.presentQpc) <= BigInt(result.receiptQpc) ||
            result.source >= Number(value.sequence)
          )
            throw new Error("Native desktop post-action present is invalid")
          return { ...result, presentQpc: value.presentQpc }
        })()
      : undefined
  if (value.v === 1 && (value.request !== undefined || value.scene !== undefined || value.presentQpc !== undefined))
    throw new Error("Native desktop unproven frame carried barrier metadata")
  if (
    value.v === 3 &&
    !proof &&
    (value.scene !== undefined ||
      value.source !== undefined ||
      value.presentQpc !== undefined ||
      value.receiptQpc !== undefined)
  )
    throw new Error("Native desktop unproven frame carried barrier metadata")
  return {
    type: "frame",
    frame: {
      ...dimensions(value),
      ...(value.v === 3 ? { epoch: generation(value) } : {}),
      ...identity(value),
      ...fingerprint(value),
      ...image(value, data),
      ...(proof ? { barrier: proof } : {}),
      acquisitionMs: number(value.acquisitionMs, "acquisition timing", 120_000),
      preparationMs: number(value.preparationMs, "preparation timing", 120_000),
    },
  }
}

function generation(value: Record<string, unknown>): number {
  const epoch = number(value.epoch, "epoch", Number.MAX_SAFE_INTEGER)
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("Native desktop epoch is invalid")
  return epoch
}

function reset(value: Record<string, unknown>, data: Buffer): NativePacket {
  if (value.v !== 3 || data.length || (value.reason !== "target_changed" && value.reason !== "display_changed"))
    throw new Error("Native desktop reset is invalid")
  return { type: "reset", reset: { epoch: generation(value), reason: value.reason } }
}

function packet(header: unknown, data: Buffer): NativePacket {
  const value = record(header)
  if (value.v !== 1 && value.v !== 2 && value.v !== 3) throw new Error("Native desktop protocol version is unsupported")
  if (value.type === "reset") return reset(value, data)
  if (value.type === "barrier") return refusal(value, data)
  if (value.type === "error") return failure(value, data)
  if (value.type === "unchanged") return unchanged(value, data)
  if (value.type === "frame") return pixels(value, data)
  throw new Error("Native desktop packet type is invalid")
}

export class NativeFrameParser {
  private readonly bytes = Buffer.allocUnsafe(LIMIT)
  private size = 0
  private sequence = 0
  private epoch = 0
  private modern = false
  private reset = false
  private image?: Pick<NativeFrame, "sequence" | "windowID" | "location" | "width" | "height" | "identity">
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
    this.epoch = 0
    this.modern = false
    this.reset = false
    this.bytes.fill(0)
  }

  private accept(result: NativePacket): void {
    if (result.type === "error" || result.type === "barrier") return
    if (result.type === "reset") {
      this.acceptReset(result.reset)
      return
    }
    const frame = result.frame
    this.acceptEpoch(frame.epoch)
    if (frame.sequence <= this.sequence) throw new Error("Native desktop frame sequence replayed")
    if (this.modern && this.image && frame.identity !== this.image.identity)
      throw new Error("Native desktop process identity changed without reset")
    if (this.modern && this.image && !this.match(frame)) throw new Error("Native desktop target changed without reset")
    if (result.type === "unchanged") {
      if (this.reset) throw new Error("Native desktop reset requires a full frame")
      if (!this.image || result.frame.base !== this.image.sequence)
        throw new Error("Native desktop unchanged packet has no matching base image")
      if (!this.match(frame)) throw new Error("Native desktop unchanged target differs from the base image")
    }
    this.sequence = frame.sequence
    if (result.type === "frame")
      this.image = {
        sequence: frame.sequence,
        windowID: frame.windowID,
        location: frame.location,
        width: frame.width,
        height: frame.height,
        identity: frame.identity,
      }
    if (result.type === "frame") this.reset = false
  }

  private acceptReset(reset: NativeReset): void {
    if ((!this.modern && (this.sequence !== 0 || reset.epoch !== 2)) || (this.modern && reset.epoch !== this.epoch + 1))
      throw new Error("Native desktop reset epoch has no matching image")
    this.modern = true
    this.epoch = reset.epoch
    this.image = undefined
    this.reset = true
  }

  private acceptEpoch(epoch: number | undefined): void {
    if (epoch === undefined) {
      if (this.modern) throw new Error("Native desktop frame protocol downgraded")
      return
    }
    if (!this.modern && (this.sequence !== 0 || epoch !== 1)) throw new Error("Native desktop initial epoch is invalid")
    if (this.modern && epoch !== this.epoch) throw new Error("Native desktop frame epoch changed without reset")
    this.modern = true
    this.epoch = epoch
  }

  private match(frame: Pick<NativeFrame, "windowID" | "location" | "width" | "height" | "identity">): boolean {
    const image = this.image
    return (
      !!image &&
      frame.windowID === image.windowID &&
      frame.location === image.location &&
      frame.width === image.width &&
      frame.height === image.height &&
      frame.identity === image.identity
    )
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
