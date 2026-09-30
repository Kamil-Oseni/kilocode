import { describe, expect, it } from "bun:test"
import { createMessageSender } from "../../webview-ui/src/context/session-send"
import type { DraftCapture } from "../../src/shared/composer-drafts-messages"
import type { WebviewMessage } from "../../webview-ui/src/types/messages"

function fixture() {
  const events: string[] = []
  const messages: WebviewMessage[] = []
  const scopes: Array<string | undefined> = []
  const send = createMessageSender({
    connected: () => true,
    current: () => "different-current-chat",
    selected: () => ({ providerID: "local", modelID: "qwen" }),
    usage: () => events.push("usage"),
    preview: () => null,
    continuation: () => undefined,
    agent: (scope) => {
      scopes.push(scope)
      return "build"
    },
    variant: () => "medium",
    post: (message) => {
      events.push("post")
      messages.push(message)
    },
    suggestions: () => [],
    questions: () => [],
    dismissSuggestion: () => events.push("dismiss-suggestion"),
    dismissQuestion: () => events.push("dismiss-question"),
    seed: () => events.push("seed"),
    prepare: () => events.push("prepare"),
    activate: () => events.push("activate"),
    draft: () => "pending-A",
  })
  return { send, events, messages, scopes }
}

function receipt(): DraftCapture {
  return {
    identity: { box: "prompt:default", key: "saved-A", sessionID: "origin-A" },
    token: { generation: crypto.randomUUID(), revision: 1 },
    mutation: crypto.randomUUID(),
    digest: "a".repeat(64),
    epoch: crypto.randomUUID(),
    generation: 1,
    owner: "owner-A",
  }
}

describe("actual session message sender", () => {
  it("allocates and seeds a fresh draft before resolving its agent and dispatching", () => {
    const f = fixture()
    f.send("Fresh text", undefined, undefined, undefined, undefined, undefined, undefined, null)
    const message = f.messages[0]
    if (message.type !== "sendMessage") throw new Error("Expected actual fresh message dispatch")
    expect(message.sessionID).toBeUndefined()
    expect(message.draftID).toMatch(/^[a-f0-9-]{36}$/)
    expect(f.scopes).toEqual([message.draftID])
    expect(f.events).toEqual(["usage", "seed", "prepare", "activate", "post"])
  })
  it("keeps captured origin, exact model and receipt when another chat is current", () => {
    const f = fixture()
    const capture = receipt()
    f.send(
      "  Keep exact whitespace  ",
      "local",
      "exact-qwen",
      undefined,
      undefined,
      "context-A",
      undefined,
      "origin-A",
      capture,
    )
    const message = f.messages[0]
    expect(message.type).toBe("sendMessage")
    if (message.type !== "sendMessage") throw new Error("Expected actual local message dispatch")
    expect(message.sessionID).toBe("origin-A")
    expect(message.capture).toBe(capture)
    expect(message.text).toBe("  Keep exact whitespace  ")
    expect(message.providerID).toBe("local")
    expect(message.modelID).toBe("exact-qwen")
    expect(message.variant).toBe("medium")
    expect(message.agentManagerContext).toBe("context-A")
    expect(f.scopes).toEqual(["origin-A"])
    expect(f.events).toEqual(["usage", "prepare", "post"])
  })

  it("prepares and activates the exact existing pending draft before dispatch", () => {
    const f = fixture()
    const capture = { ...receipt(), identity: { box: "prompt:default", key: "pending-A", pendingID: "pending-A" } }
    f.send("Pending text", undefined, undefined, undefined, "pending-A", undefined, undefined, null, capture)
    const message = f.messages[0]
    expect(message.type).toBe("sendMessage")
    if (message.type !== "sendMessage") throw new Error("Expected actual pending message dispatch")
    expect(message.sessionID).toBeUndefined()
    expect(message.draftID).toBe("pending-A")
    expect(message.capture).toBe(capture)
    expect(f.scopes).toEqual(["pending-A"])
    expect(f.events).toEqual(["usage", "prepare", "activate", "post"])
  })
})
