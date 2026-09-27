import { describe, expect, it } from "bun:test"
import { createAbortState } from "../../webview-ui/src/context/abort-state"

describe("pending prompt abort state", () => {
  it("waits for the same submission to become cancellable", () => {
    const aborts = createAbortState()

    expect(aborts.request("draft", "idle", "message")).toBe(false)
    expect(aborts.update("draft", "busy")).toBe("user-stop")
    expect(aborts.update("draft", "busy")).toBeUndefined()
    expect(aborts.update("draft", "idle")).toBeUndefined()
    expect(aborts.update("draft", "busy")).toBeUndefined()
  })

  it("moves pending cancellation to the created session", () => {
    const aborts = createAbortState()

    expect(aborts.request("draft", "idle", "message")).toBe(false)
    aborts.move("draft", "session")

    expect(aborts.update("draft", "busy")).toBeUndefined()
    expect(aborts.update("session", "busy")).toBe("user-stop")
  })

  it("does not retain cancellation after an idle terminal status", () => {
    const aborts = createAbortState()

    expect(aborts.request("session", "idle", "message")).toBe(false)
    expect(aborts.update("session", "idle")).toBeUndefined()
    expect(aborts.update("session", "busy")).toBeUndefined()
  })

  it("allows retrying an abort while the session remains active", () => {
    const aborts = createAbortState()

    expect(aborts.request("session", "busy")).toBe(true)
    expect(aborts.request("session", "busy")).toBe(true)
    expect(aborts.update("session", "idle")).toBeUndefined()
    expect(aborts.request("session", "busy")).toBe(true)
  })

  it("clears cancellation when the matching submission finishes", () => {
    const aborts = createAbortState()

    expect(aborts.request("session", "idle", "message")).toBe(false)
    aborts.finish("other")
    expect(aborts.update("session", "busy")).toBe("user-stop")

    expect(aborts.update("session", "idle")).toBeUndefined()
    expect(aborts.request("session", "idle", "message")).toBe(false)
    aborts.finish("message")
    expect(aborts.update("session", "busy")).toBeUndefined()
  })

  it("preserves active destination state during duplicate draft migration", () => {
    const aborts = createAbortState()

    expect(aborts.request("draft", "idle", "message")).toBe(false)
    expect(aborts.request("session", "busy")).toBe(true)
    aborts.move("draft", "session")

    expect(aborts.request("session", "busy")).toBe(true)
  })

  it("preserves Escape provenance until a pending request becomes active", () => {
    const aborts = createAbortState()
    expect(aborts.request("draft", "idle", "message", "user-escape")).toBe(false)
    aborts.move("draft", "session")
    expect(aborts.update("session", "busy")).toBe("user-escape")
  })
})
