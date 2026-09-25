import type { DesktopAction, DesktopDispatchTarget } from "./desktop-session"

export type NativeInputTarget = {
  windowID: string
  pid: number
  identity: string
  left: number
  top: number
  right: number
  bottom: number
  scene: number
  observedAt: number
  validUntil: number
}

const keys: Record<string, number> = {
  Backspace: 0x08,
  Tab: 0x09,
  Enter: 0x0d,
  Shift: 0x10,
  Control: 0x11,
  Alt: 0x12,
  Escape: 0x1b,
  Space: 0x20,
  PageUp: 0x21,
  PageDown: 0x22,
  End: 0x23,
  Home: 0x24,
  ArrowLeft: 0x25,
  ArrowUp: 0x26,
  ArrowRight: 0x27,
  ArrowDown: 0x28,
  Delete: 0x2e,
  Meta: 0x5b,
}

function point(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new Error("Native desktop coordinates must be normalized")
  return Math.round(value * 1_000_000)
}

function delta(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > 1_200)
    throw new Error("Native desktop scroll exceeds the bounded range")
  return Math.round(value)
}

function chord(action: Extract<DesktopAction, { operation: "key" }>) {
  const key =
    keys[action.key] ??
    (/^[A-Za-z0-9]$/.test(action.key) ? action.key.toUpperCase().charCodeAt(0) : undefined) ??
    (/^F([1-9]|1[0-2])$/.test(action.key) ? 0x6f + Number(action.key.slice(1)) : undefined)
  if (key === undefined) throw new Error("Unsupported native desktop key")
  const modifiers = new Set(action.modifiers ?? [])
  if (modifiers.size !== (action.modifiers?.length ?? 0)) throw new Error("Duplicate native desktop modifier")
  const mask =
    (modifiers.has("shift") ? 1 : 0) |
    (modifiers.has("control") ? 2 : 0) |
    (modifiers.has("alt") ? 4 : 0) |
    (modifiers.has("meta") ? 8 : 0)
  return { action: "chord", a: key, b: mask, c: 0, d: 0, e: 0, payload: Buffer.alloc(0) }
}

export function input(action: DesktopAction) {
  if (action.operation === "pointer")
    return {
      action: action.action === "double_click" ? "double_click" : action.action,
      a: point(action.x),
      b: point(action.y),
      c: action.button === "right" ? 1 : 0,
      d: 0,
      e: 0,
      payload: Buffer.alloc(0),
    }
  if (action.operation === "drag")
    return {
      action: "drag",
      a: point(action.startX),
      b: point(action.startY),
      c: point(action.endX),
      d: point(action.endY),
      e: action.button === "right" ? 1 : 0,
      payload: Buffer.alloc(0),
    }
  if (action.operation === "scroll")
    return {
      action: "scroll",
      a: delta(action.deltaX),
      b: delta(action.deltaY),
      c: 0,
      d: 0,
      e: 0,
      payload: Buffer.alloc(0),
    }
  if (action.operation === "type") {
    const payload = Buffer.from(action.text, "utf16le")
    if (!payload.length || payload.length > 512 || action.text.includes("\0"))
      throw new Error("Native desktop text exceeds the bounded Unicode input")
    return { action: "text", a: 0, b: 0, c: 0, d: 0, e: 0, payload }
  }
  return chord(action)
}

export function target(value: NativeInputTarget) {
  if (
    !/^0x[0-9a-fA-F]+$/.test(value.windowID) ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0 ||
    value.pid > 0xffffffff ||
    !/^[A-F0-9]{64}$/.test(value.identity) ||
    ![value.left, value.top, value.right, value.bottom].every(
      (item) => Number.isInteger(item) && item >= -0x80000000 && item <= 0x7fffffff,
    ) ||
    value.left >= value.right ||
    value.top >= value.bottom ||
    !Number.isSafeInteger(value.scene) ||
    value.scene <= 0 ||
    !Number.isSafeInteger(value.observedAt) ||
    !Number.isSafeInteger(value.validUntil) ||
    value.observedAt <= 0 ||
    value.validUntil <= value.observedAt ||
    value.validUntil - value.observedAt > 10_000
  )
    throw new Error("Native desktop target or scene is invalid")
  return { ...value, windowID: value.windowID.slice(2).toLowerCase() }
}

export function resolve(value: DesktopDispatchTarget): NativeInputTarget {
  const match = /^pid:(\d+);title:[\s\S]*;bounds:(-?\d+),(-?\d+),(\d+),(\d+)$/.exec(value.location ?? "")
  if (!match || !value.identity) throw new Error("Native desktop dispatch requires observed window bounds and identity")
  const [pid, left, top, width, height] = match.slice(1).map(Number)
  return target({
    windowID: value.windowID,
    pid,
    identity: value.identity,
    left,
    top,
    right: left + width,
    bottom: top + height,
    scene: value.scene,
    observedAt: value.observedAt,
    validUntil: value.validUntil,
  })
}
