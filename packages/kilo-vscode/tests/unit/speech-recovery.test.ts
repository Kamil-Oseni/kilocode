import { expect, test } from "bun:test"
import { speechRecovery } from "../../webview-ui/src/components/speech-to-text/recovery"

const origin = { box: "box", key: "pending:original", owner: "owner", context: "context", session: null, route: null }

function fixture() {
  let state: unknown = { unrelated: { revision: 7 } }
  const vscode = {
    getState: <T>() => state as T,
    setState: <T>(value: T) => {
      state = value
    },
  }
  return {
    vscode,
    read: () => state,
    write: (value: unknown) => {
      state = value
    },
  }
}

test("real recovery preserves unrelated state, exact UTF-8 boundary and one unresolved record across remount", () => {
  const ctx = fixture()
  const saved = speechRecovery(ctx.vscode)
  const text = "\u0001".repeat(262_144)
  expect(saved.check(origin, "request", text)).toBe(true)
  expect(saved.retain(origin, "request", text)).toBe(true)
  expect(saved.value()?.text).toBe(text)
  expect(saved.blocked()).toBe(true)
  expect(ctx.read()).toMatchObject({ unrelated: { revision: 7 } })
  const remounted = speechRecovery(ctx.vscode)
  expect(remounted.value()?.request).toBe("request")
  expect(remounted.retain(origin, "other", "Replacement")).toBe(false)
  expect(remounted.value()?.text).toBe(text)
  remounted.discard()
  expect(remounted.blocked()).toBe(false)
  expect(ctx.read()).toEqual({ unrelated: { revision: 7 } })
})

test("recovery rejects excess Unicode bytes without truncation or retaining oversized text", () => {
  const ctx = fixture()
  const saved = speechRecovery(ctx.vscode)
  expect(saved.check(origin, "request", "😀".repeat(65_536))).toBe(true)
  expect(saved.check(origin, "request", "😀".repeat(65_536) + "a")).toBe(false)
  expect(saved.value()).toMatchObject({ request: "request", status: "capacity", text: null })
  expect(JSON.stringify(ctx.read()).length).toBeLessThan(1024)
  expect(saved.blocked()).toBe(true)
})

test("foreign and malformed recovery are display-only refusals and never valid insertion authority", () => {
  const ctx = fixture()
  ctx.write({
    unrelated: 1,
    rayaSpeechRecoveryV1: { ...origin, version: 1, request: "original", status: "text", text: "Kept", extra: true },
  })
  const saved = speechRecovery(ctx.vscode)
  expect(saved.value()).toBeUndefined()
  expect(saved.blocked()).toBe(true)
  expect(saved.retain(origin, "replacement", "New")).toBe(false)
  expect(ctx.read()).toMatchObject({ rayaSpeechRecoveryV1: { extra: true } })
  saved.discard()
  expect(ctx.read()).toEqual({ unrelated: 1 })
})

test("a persistence failure retains bounded recognized text in the mounted view until explicit discard", () => {
  const ctx = fixture()
  const saved = speechRecovery({
    ...ctx.vscode,
    setState: () => {
      throw new Error("Unavailable")
    },
  })
  expect(saved.retain(origin, "request", "Copy before closing")).toBe(false)
  expect(saved.value()?.text).toBe("Copy before closing")
  expect(saved.error()).toContain("across reload")
  expect(saved.blocked()).toBe(true)
})

test("an old mounted recovery cannot discard a newer pane's transcript", () => {
  const ctx = fixture()
  const first = speechRecovery(ctx.vscode)
  first.retain(origin, "first", "Original")
  const second = speechRecovery(ctx.vscode)
  second.discard()
  second.retain({ ...origin, box: "second" }, "second", "Newer")
  first.discard()
  expect(first.error()).toContain("Speech recovery changed")
  expect(speechRecovery(ctx.vscode).value()?.text).toBe("Newer")
  expect(first.value()?.text).toBe("Original")
})

test("malformed recovery discard compares a bounded immutable snapshot across cloned reads and in-place mutation", () => {
  const ctx = fixture()
  ctx.write({ unrelated: 1, rayaSpeechRecoveryV1: { malformed: "original" } })
  const saved = speechRecovery({ ...ctx.vscode, getState: <T>() => structuredClone(ctx.read()) as T })
  saved.discard()
  expect(ctx.read()).toEqual({ unrelated: 1 })
  const raw = { malformed: "original" }
  ctx.write({ unrelated: 2, rayaSpeechRecoveryV1: raw })
  const stale = speechRecovery(ctx.vscode)
  raw.malformed = "changed"
  stale.discard()
  expect(ctx.read()).toMatchObject({ rayaSpeechRecoveryV1: { malformed: "changed" } })
  expect(stale.error()).toContain("preserved")
})

test("publish requires readback and failed discard preserves the retained record", () => {
  const ctx = fixture()
  const unavailable = speechRecovery({ ...ctx.vscode, setState: () => undefined })
  expect(unavailable.retain(origin, "request", "Mounted fallback")).toBe(false)
  expect(unavailable.value()?.text).toBe("Mounted fallback")
  expect(unavailable.error()).toContain("across reload")
  const saved = speechRecovery(ctx.vscode)
  saved.retain(origin, "request", "Keep")
  const failing = speechRecovery({
    ...ctx.vscode,
    setState: () => {
      throw new Error("Unavailable")
    },
  })
  failing.discard()
  expect(failing.value()?.text).toBe("Keep")
  expect(failing.error()).toContain("Could not discard")
  expect(speechRecovery(ctx.vscode).value()?.text).toBe("Keep")
})
