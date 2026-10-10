import { createSignal } from "solid-js"

const slot = "rayaSpeechRecoveryV1"
const maximum = 262_144
const fields = ["box", "key", "owner", "context", "session", "route"] as const

type Origin = Record<(typeof fields)[number], string | null>
type Saved = Origin & { version: 1; request: string; status: "text" | "capacity"; text: string | null }
type State = { getState: <T>() => T | undefined; setState: <T>(value: T) => void }
const revisions = new WeakMap<State, { get: () => number; next: () => void }>()

// Count UTF-8 without first allocating an encoding of an unbounded endpoint result.
function fits(text: string, maximum: number) {
  let bytes = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    bytes += code < 128 ? 1 : code < 2048 ? 2 : 3
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        index++
        bytes++
      }
    }
    if (bytes > maximum) return false
  }
  return true
}

function object(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function properties(value: Record<string, unknown>) {
  let count = 0
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue
    if (++count > 10) return false
    const property = Object.getOwnPropertyDescriptor(value, key)
    if (!property || !("value" in property)) return false
  }
  return count === 10
}

function origin(value: Record<string, unknown>) {
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) return false
    const part = value[field]
    if (part !== null && (typeof part !== "string" || !fits(part, 4096))) return false
  }
  return true
}

function parse(value: unknown): Saved | undefined {
  if (!object(value) || !properties(value) || !origin(value)) return
  if (value.version !== 1 || typeof value.request !== "string" || !value.request || !fits(value.request, 256)) return
  if (value.status === "capacity" && value.text === null) return Object.freeze({ ...value }) as Saved
  if (value.status !== "text" || typeof value.text !== "string" || !value.text || !fits(value.text, maximum)) return
  // Each primitive was bounded above: even six-byte JSON escapes remain below 2 MiB.
  if (!fits(JSON.stringify(value), 2_097_152)) return
  return Object.freeze({ ...value }) as Saved
}

function snapshot(value: unknown) {
  const budget = { bytes: 0, nodes: 0 }
  const container = (value: unknown, depth: number): { value: unknown } | undefined => {
    if (!object(value) && !Array.isArray(value)) return
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return
    if (Array.isArray(value)) {
      budget.nodes += value.length
      budget.bytes += value.length * 6
      if (budget.nodes > 8192 || budget.bytes > 2_097_152) return
    }
    const next: Record<string, unknown> | unknown[] = Array.isArray(value)
      ? new Array(value.length)
      : Object.create(null)
    let keys = 0
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue
      if (++keys > 8192) return
      budget.bytes += key.length * 6
      if (budget.bytes > 2_097_152) return
      const property = Object.getOwnPropertyDescriptor(value, key)
      if (!property || !("value" in property)) return
      const child = copy(property.value, depth + 1)
      if (!child) return
      Object.defineProperty(next, key, { value: child.value, enumerable: true, configurable: true, writable: true })
    }
    return { value: next }
  }
  const copy = (value: unknown, depth: number): { value: unknown } | undefined => {
    budget.bytes += 64
    if (++budget.nodes > 8192 || depth > 8 || budget.bytes > 2_097_152) return
    if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
      return { value }
    if (typeof value === "string") {
      budget.bytes += value.length * 6
      return budget.bytes <= 2_097_152 ? { value } : undefined
    }
    return container(value, depth)
  }
  const copied = copy(value, 0)
  return copied ? JSON.stringify(copied.value) : undefined
}

export function speechRecovery(vscode: State) {
  if (!revisions.has(vscode)) {
    const [get, set] = createSignal(0)
    revisions.set(vscode, { get, next: () => set((value) => value + 1) })
  }
  const revision = revisions.get(vscode)!
  const state = () => vscode.getState<unknown>()
  const read = () => {
    revision.get()
    const value = state()
    return object(value) ? value[slot] : undefined
  }
  const initial = read()
  const invalid = parse(initial) ? undefined : snapshot(initial)
  const [held, setHeld] = createSignal<unknown>(initial)
  const [saved, setSaved] = createSignal<Saved | undefined>(parse(initial))
  const [error, setError] = createSignal<string>()
  const value = () => saved() ?? parse(read())
  const same = (left: Saved, right: Saved) =>
    [...fields, "version", "request", "status", "text"].every(
      (field) => left[field as keyof Saved] === right[field as keyof Saved],
    )
  const blocked = () => held() !== undefined || read() !== undefined || !!error()
  const publish = (value: Saved) => {
    if (blocked()) throw new Error("Resolve the retained speech transcript before recording again.")
    const current = state()
    if (current !== undefined && !object(current)) throw new Error("Speech recovery could not preserve webview state.")
    vscode.setState({ ...(current ?? {}), [slot]: value })
    const stored = parse(read())
    if (!stored || !same(stored, value)) throw new Error("Speech recovery storage did not retain this transcript.")
    setHeld(value)
    setSaved(value)
    revision.next()
  }
  const save = (origin: Origin, request: string, text: string, status: Saved["status"]) => {
    const saved = parse({ ...origin, request, version: 1, status, text: status === "text" ? text : null })
    if (!saved) {
      setError("Speech recovery metadata could not be retained. The transcript was not inserted.")
      return false
    }
    try {
      publish(saved)
      return true
    } catch {
      // Keep recognized text in this mounted composer even if persistence is unavailable.
      if (held() === undefined) {
        setHeld(saved)
        setSaved(saved)
      }
      setError("Speech recovery could not be saved across reload. Copy it before closing this view.")
      return false
    }
  }
  return {
    value,
    stale() {
      const original = saved()
      const current = parse(read())
      return !!original && (!current || !same(original, current))
    },
    blocked,
    error,
    check(origin: Origin, request: string, text: string) {
      if (fits(text, maximum)) return true
      save(origin, request, "", "capacity")
      return false
    },
    retain: (origin: Origin, request: string, text: string) => save(origin, request, text, "text"),
    discard() {
      const current = state()
      if (current !== undefined && !object(current)) {
        setError("Speech recovery could not update webview state.")
        return
      }
      const next = { ...(current ?? {}) }
      const stored = object(current) ? current[slot] : undefined
      const parsed = parse(stored)
      const original = saved()
      if (
        stored !== undefined &&
        !(original && parsed
          ? same(original, parsed)
          : !parsed && invalid !== undefined && snapshot(stored) === invalid)
      ) {
        setError(
          "Speech recovery changed or cannot be compared safely. It was preserved; reopen the view to review it.",
        )
        return
      }
      delete next[slot]
      try {
        vscode.setState(next)
        if (read() !== undefined) throw new Error("Speech recovery discard was not retained.")
      } catch {
        setError("Could not discard speech recovery. It is still retained here.")
        return
      }
      setHeld(undefined)
      setSaved(undefined)
      setError(undefined)
      revision.next()
    },
  }
}
