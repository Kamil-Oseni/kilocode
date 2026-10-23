import { describe, expect, it } from "bun:test"
import { createSessionVariants } from "../../webview-ui/src/context/session-variants"
import type { ExtensionMessage, ModelSelection } from "../../webview-ui/src/types/messages"
import { createStore, reconcile } from "solid-js/store"

const model: ModelSelection = { providerID: "anthropic", modelID: "claude-sonnet-4" }

function setup(session?: string) {
  const selections: Record<string, string> = {}
  const messages: Array<{ type: string; key?: string; value?: string }> = []
  const order: string[] = []
  let handler: ((message: ExtensionMessage) => void) | undefined
  const variants = createSessionVariants({
    selections: () => selections,
    set: (key, value) => {
      selections[key] = value
    },
    replace: (values) => {
      for (const key of Object.keys(selections)) delete selections[key]
      Object.assign(selections, values)
    },
    selected: () => model,
    session: () => session,
    agent: () => "code",
    find: () => ({ variants: { low: {}, high: {} } }),
    post: (message) => {
      order.push("post")
      messages.push(message)
    },
    listen: (next) => {
      order.push("listen")
      handler = next
      return () => order.push("unsub")
    },
  })
  return { variants, selections, messages, order, dispatch: (message: ExtensionMessage) => handler?.(message) }
}

describe("session variants", () => {
  it("replaces restored picker variants in the actual store while retaining current session overrides", () => {
    const [state, set] = createStore({
      variants: {
        "agent/code/anthropic/claude-sonnet-4": "low",
        "agent/ask/anthropic/claude-sonnet-4": "high",
        "anthropic/claude-sonnet-4": "high",
        "session/current/anthropic/claude-sonnet-4": "high",
      } as Record<string, string>,
    })
    const sent: { type: string }[] = []
    let receive: ((message: ExtensionMessage) => void) | undefined
    const variants = createSessionVariants({
      selections: () => state.variants,
      set: (key, value) => set("variants", key, value),
      replace: (values) => set("variants", reconcile(values)),
      selected: () => model,
      session: () => undefined,
      agent: () => "code",
      find: () => ({ variants: { low: {}, high: {} } }),
      post: (message) => sent.push(message),
      listen: (handler) => {
        receive = handler
        return () => {
          receive = undefined
        }
      },
    })
    const close = variants.load()
    receive?.({
      type: "variantsLoaded",
      replace: true,
      variants: {
        "agent/code/anthropic/claude-sonnet-4": "",
        "anthropic/claude-sonnet-4": "high",
        "session/old/anthropic/claude-sonnet-4": "low",
      },
    })
    expect({ ...state.variants }).toEqual({
      "agent/code/anthropic/claude-sonnet-4": "",
      "anthropic/claude-sonnet-4": "high",
      "session/current/anthropic/claude-sonnet-4": "high",
    })
    expect(variants.current()).toBeUndefined()
    expect(variants.current("current")).toBe("high")
    receive?.({ type: "variantsLoaded", replace: true, variants: {} })
    expect({ ...state.variants }).toEqual({ "session/current/anthropic/claude-sonnet-4": "high" })
    expect(variants.current()).toBeUndefined()
    expect(sent).toEqual([{ type: "requestVariants" }])
    close()
  })

  it("subscribes before requesting persisted variants and returns cleanup", () => {
    const state = setup()
    const unsub = state.variants.load()
    expect(state.order).toEqual(["listen", "post"])
    expect(state.messages).toEqual([{ type: "requestVariants" }])
    unsub()
    expect(state.order).toEqual(["listen", "post", "unsub"])
  })

  it("loads global variants without restoring stale session variants", () => {
    const state = setup()
    state.variants.load()
    state.dispatch({
      type: "variantsLoaded",
      variants: { "agent/code/anthropic/claude-sonnet-4": "high", "session/old/model": "low" },
    })
    expect(state.selections).toEqual({ "agent/code/anthropic/claude-sonnet-4": "high" })
  })

  it("persists global selections but keeps session selections local", () => {
    const global = setup()
    global.variants.select("high")
    expect(global.messages).toEqual([
      { type: "persistVariant", key: "agent/code/anthropic/claude-sonnet-4", value: "high" },
    ])

    const scoped = setup("session-a")
    scoped.variants.select("low")
    expect(scoped.selections).toEqual({ "session/session-a/anthropic/claude-sonnet-4": "low" })
    expect(scoped.messages).toEqual([])
  })

  it("persists an explicit default selection", () => {
    const state = setup()
    state.selections["agent/code/anthropic/claude-sonnet-4"] = "high"
    state.variants.select(undefined)
    expect(state.selections).toEqual({ "agent/code/anthropic/claude-sonnet-4": "" })
    expect(state.variants.current()).toBeUndefined()
    expect(state.messages).toEqual([{ type: "persistVariant", key: "agent/code/anthropic/claude-sonnet-4", value: "" }])
  })

  it("does not shadow a cached variant when carrying the model default", () => {
    const global = setup()
    global.selections["agent/code/anthropic/claude-sonnet-4"] = "high"
    global.variants.carry(model, undefined, "code")
    expect(global.selections).toEqual({ "agent/code/anthropic/claude-sonnet-4": "high" })
    expect(global.messages).toEqual([])

    const session = setup("session-a")
    session.selections["agent/code/anthropic/claude-sonnet-4"] = "high"
    session.variants.carry(model, undefined, "code", "session-a")
    expect(session.selections).toEqual({ "agent/code/anthropic/claude-sonnet-4": "high" })
    expect(session.variants.current()).toBe("high")
  })
})
