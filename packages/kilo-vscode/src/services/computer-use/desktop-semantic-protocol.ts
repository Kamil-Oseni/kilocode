import type { DesktopControl, DesktopSemantics } from "./desktop-session"

export type Request = { request: string; generation: number; windowID: string; identity: string; location: string }
export type Reply =
  | { version: 1; request: string; generation: number; type: "error"; code: string }
  | {
      version: 1
      request: string
      generation: number
      windowID: string
      identity: string
      viewport: DesktopSemantics["viewport"]
      clock: { version: 1; acquisition: string; prepared: string; frequency: string }
      semantics: DesktopSemantics
    }

function fail(): never {
  throw new Error("Native desktop semantic protocol is invalid")
}

function record(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail()
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return fail()
  const names = Reflect.ownKeys(value)
  if (names.some((key) => typeof key !== "string" || (!keys.includes(key) && !optional.includes(key)))) return fail()
  if (keys.some((key) => !Object.hasOwn(value, key))) return fail()
  if (names.some((key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"))) return fail()
  return value as Record<string, unknown>
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return fail()
  return value
}

function counter(value: unknown, max = 9_223_372_036_854_775_807n): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > max) return fail()
  return value
}

function text(value: unknown, max: number, pattern?: RegExp): string {
  if (typeof value !== "string" || !value.length || value.length > max || /[\u0000-\u001f\u007f]/u.test(value))
    return fail()
  if (pattern && !pattern.test(value)) return fail()
  return value
}

function target(input: Request) {
  record(input, ["request", "generation", "windowID", "identity", "location"])
  text(input.request, 32, /^[a-f0-9]{32}$/)
  integer(input.generation, 1, Number.MAX_SAFE_INTEGER)
  text(input.windowID, 18, /^0x[1-9A-F][0-9A-F]{0,15}$/)
  text(input.identity, 64, /^[A-F0-9]{64}$/)
  if (typeof input.location !== "string" || input.location.length > 16_384 || input.location.includes("\0"))
    return fail()
  const match = /^pid:(\d+);title:[\s\S]*;bounds:(-?\d+),(-?\d+),(\d+),(\d+)$/.exec(input.location)
  if (!match) return fail()
  const pid = integer(Number(match[1]), 1, 0xffffffff)
  const x = integer(Number(match[2]), -0x80000000, 0x7fffffff)
  const y = integer(Number(match[3]), -0x80000000, 0x7fffffff)
  const width = integer(Number(match[4]), 1, 0x7fffffff)
  const height = integer(Number(match[5]), 1, 0x7fffffff)
  integer(x + width, -0x80000000, 0x7fffffff)
  integer(y + height, -0x80000000, 0x7fffffff)
  return { pid, x, y, width, height }
}

export function encode(input: Request): Buffer {
  const view = target(input)
  const data = Buffer.alloc(144)
  data.write("RYSM", 0, "ascii")
  data.writeUInt32LE(1, 4)
  data.writeUInt32LE(144, 8)
  data.writeBigUInt64LE(BigInt(input.generation), 12)
  data.writeBigUInt64LE(BigInt(input.windowID), 20)
  data.writeUInt32LE(view.pid, 28)
  data.writeInt32LE(view.x, 32)
  data.writeInt32LE(view.y, 36)
  data.writeInt32LE(view.x + view.width, 40)
  data.writeInt32LE(view.y + view.height, 44)
  data.write(input.identity, 48, "ascii")
  data.write(input.request, 112, "ascii")
  return data
}

function decode(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    if (value.length > 1_048_576) return fail()
    return json(new TextDecoder("utf-8", { fatal: true }).decode(value))
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > 1_048_576) return fail()
    return json(value)
  }
  return value
}

function json(value: string): unknown {
  const output: unknown = (() => {
    try {
      return JSON.parse(value) as unknown
    } catch {
      // JSON syntax errors can quote private native output. Never forward their text.
      return fail()
    }
  })()
  const tokens = value.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g) ?? []
  const stack: (Set<string> | undefined)[] = []
  for (const [index, token] of tokens.entries()) {
    if (token === "{" || token === "[") {
      stack.push(token === "{" ? new Set() : undefined)
      if (stack.length > 64) return fail()
      continue
    }
    if (token === "}" || token === "]") {
      stack.pop()
      continue
    }
    const keys = stack.at(-1)
    if (!keys || !token.startsWith('"') || tokens[index + 1] !== ":") continue
    const key: string = JSON.parse(token)
    if (keys.has(key)) return fail()
    keys.add(key)
  }
  return output
}

function viewport(value: unknown): DesktopSemantics["viewport"] {
  const input = record(value, ["x", "y", "width", "height"])
  const x = integer(input.x, -0x80000000, 0x7fffffff)
  const y = integer(input.y, -0x80000000, 0x7fffffff)
  const width = integer(input.width, 1, 0x7fffffff)
  const height = integer(input.height, 1, 0x7fffffff)
  integer(x + width, -0x80000000, 0x7fffffff)
  integer(y + height, -0x80000000, 0x7fffffff)
  return { x, y, width, height }
}

function same(left: DesktopSemantics["viewport"], right: DesktopSemantics["viewport"]) {
  if (left.x !== right.x || left.y !== right.y || left.width !== right.width || left.height !== right.height) fail()
}

const actions = new Set(["invoke", "select", "toggle", "expand_collapse", "value", "scroll"])

function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) return fail()
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1) return fail()
  if (
    keys.some(
      (key) =>
        key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length),
    )
  )
    return fail()
  if (keys.some((key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"))) return fail()
  return value
}

function control(value: unknown): DesktopControl {
  const input = record(
    value,
    ["controlID", "role", "x", "y", "width", "height", "enabled", "focused", "actions"],
    ["name", "automationID", "selected"],
  )
  const controlID = text(input.controlID, 200)
  const role = text(input.role, 100)
  if (typeof input.enabled !== "boolean" || typeof input.focused !== "boolean") return fail()
  if (Object.hasOwn(input, "selected") && typeof input.selected !== "boolean") return fail()
  const list = array(input.actions, 6)
  if (new Set(list).size !== list.length || list.some((item) => typeof item !== "string" || !actions.has(item)))
    return fail()
  const x = integer(input.x, -0x80000000, 0x7fffffff)
  const y = integer(input.y, -0x80000000, 0x7fffffff)
  const width = integer(input.width, 0, 0x7fffffff)
  const height = integer(input.height, 0, 0x7fffffff)
  integer(x + width, -0x80000000, 0x7fffffff)
  integer(y + height, -0x80000000, 0x7fffffff)
  const name = Object.hasOwn(input, "name") ? text(input.name, 512) : undefined
  if (name && /^(edit|document|password)$/i.test(role)) return fail()
  return {
    controlID,
    role,
    x,
    y,
    width,
    height,
    enabled: input.enabled,
    focused: input.focused,
    actions: [...list] as DesktopControl["actions"],
    ...(name ? { name } : {}),
    ...(Object.hasOwn(input, "automationID") ? { automationID: text(input.automationID, 200) } : {}),
    ...(typeof input.selected === "boolean" ? { selected: input.selected } : {}),
  }
}

function correlation(input: Record<string, unknown>, request: Request) {
  target(request)
  if (input.version !== 1 || input.request !== request.request || input.generation !== request.generation) fail()
}

export function clock(value: unknown, request: Request) {
  const input = record(decode(value), ["version", "type", "request", "generation", "qpc", "frequency"])
  correlation(input, request)
  if (input.type !== "clock") return fail()
  return {
    version: 1 as const,
    type: "clock" as const,
    request: request.request,
    generation: request.generation,
    qpc: counter(input.qpc),
    frequency: counter(input.frequency, 10_000_000_000n),
  }
}

export function parse(value: unknown, request: Request): Reply {
  const raw = decode(value)
  const base = record(
    raw,
    ["version", "request", "generation"],
    ["type", "code", "windowID", "identity", "viewport", "clock", "semantics"],
  )
  correlation(base, request)
  if (base.type === "error") {
    const input = record(raw, ["version", "request", "generation", "type", "code"])
    return {
      version: 1,
      request: request.request,
      generation: request.generation,
      type: "error",
      code: text(input.code, 80, /^[a-z][a-z0-9_]*$/),
    }
  }
  const input = record(raw, [
    "version",
    "request",
    "generation",
    "windowID",
    "identity",
    "viewport",
    "clock",
    "semantics",
  ])
  if (input.windowID !== request.windowID || input.identity !== request.identity) return fail()
  const view = viewport(input.viewport)
  same(view, target(request))
  const timing = record(input.clock, ["version", "acquisition", "prepared", "frequency"])
  if (timing.version !== 1) return fail()
  const acquisition = counter(timing.acquisition)
  const prepared = counter(timing.prepared)
  if (BigInt(prepared) < BigInt(acquisition)) return fail()
  const frequency = counter(timing.frequency, 10_000_000_000n)
  const semantic = record(input.semantics, ["source", "status", "viewport", "controls", "truncated"])
  if (
    semantic.source !== "windows_ui_automation" ||
    (semantic.status !== "available" && semantic.status !== "unavailable") ||
    typeof semantic.truncated !== "boolean"
  )
    return fail()
  const bounds = viewport(semantic.viewport)
  same(view, bounds)
  const controls = array(semantic.controls, 256).map(control)
  if (new Set(controls.map((item) => item.controlID)).size !== controls.length) return fail()
  if (semantic.status === "unavailable" && (controls.length || semantic.truncated)) return fail()
  return {
    version: 1,
    request: request.request,
    generation: request.generation,
    windowID: request.windowID,
    identity: request.identity,
    viewport: view,
    clock: { version: 1, acquisition, prepared, frequency },
    semantics: {
      source: "windows_ui_automation",
      status: semantic.status,
      viewport: bounds,
      controls,
      truncated: semantic.truncated,
    },
  }
}
