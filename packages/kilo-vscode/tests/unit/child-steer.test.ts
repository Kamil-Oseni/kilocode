import { describe, expect, test } from "bun:test"
import {
  applySteerResult,
  canSteer,
  steerID,
  steerKey,
  type ChildSteerDraft,
} from "../../webview-ui/src/components/chat/child-steer"

const working = (text: string, messageID = "msg_1"): ChildSteerDraft => ({ text, messageID, stage: "working" })

describe("child steer state", () => {
  test("creates a backend-compatible message identity", () => {
    expect(steerID()).toMatch(/^msg_[0-9a-f-]{36}$/)
  })

  test("correlates a result to the exact parent, child, and message", () => {
    const key = steerKey("parent", "child")
    const drafts = { [key]: working("Keep this text") }

    expect(
      applySteerResult(drafts, {
        type: "childSteerResult",
        parentSessionID: "parent",
        childSessionID: "other-child",
        messageID: "msg_1",
        accepted: true,
        replayed: false,
      }),
    ).toBe(drafts)
    expect(
      applySteerResult(drafts, {
        type: "childSteerResult",
        parentSessionID: "parent",
        childSessionID: "child",
        messageID: "stale-message",
        accepted: true,
        replayed: false,
      }),
    ).toBe(drafts)
  })

  test("clears only a matching accepted draft, including a replay", () => {
    const key = steerKey("parent", "child")
    const other = steerKey("parent", "other")
    const drafts = { [key]: working("Send once"), [other]: working("Keep me", "msg_2") }
    const next = applySteerResult(drafts, {
      type: "childSteerResult",
      parentSessionID: "parent",
      childSessionID: "child",
      messageID: "msg_1",
      accepted: true,
      replayed: true,
    })

    expect(next[key]).toEqual({ text: "", stage: "accepted" })
    expect(next[other]).toBe(drafts[other])
  })

  test("preserves text and the typed reason after a failed admission", () => {
    const key = steerKey("parent", "child")
    const next = applySteerResult(
      { [key]: working("Do not lose this") },
      {
        type: "childSteerResult",
        parentSessionID: "parent",
        childSessionID: "child",
        messageID: "msg_1",
        accepted: false,
        code: "stale-run",
        error: "The child changed.",
      },
    )

    expect(next[key]).toEqual({
      text: "Do not lose this",
      stage: "failed",
      messageID: "msg_1",
      code: "stale-run",
      error: "The child changed.",
    })
  })

  test("enables only bounded text for an active child", () => {
    const ready: ChildSteerDraft = { text: "Inspect the parser", stage: "ready" }
    expect(canSteer("busy", ready)).toBe(true)
    expect(canSteer("retry", ready)).toBe(true)
    expect(canSteer(undefined, ready)).toBe(false)
    expect(canSteer("idle", ready)).toBe(false)
    expect(canSteer("offline", ready)).toBe(false)
    expect(canSteer("busy", { ...ready, text: " " })).toBe(false)
    expect(canSteer("busy", { ...ready, text: "x".repeat(32_001) })).toBe(false)
    expect(canSteer("busy", working("Already sending"))).toBe(false)
  })
})
