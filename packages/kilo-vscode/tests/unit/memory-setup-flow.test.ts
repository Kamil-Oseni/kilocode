import { expect, test } from "bun:test"
import { SetupFlow } from "../../src/second-brain/setup-flow"

function fixture() {
  const state = {
    configured: false,
    root: "C:/Synthetic/SecondBrain",
    index: "unchecked" as "unchecked" | "approved" | "synced",
    capture: "unavailable" as "unavailable" | "ready",
    recovery: false,
  }
  const candidate = { root: state.root, capture: false, identity: "original", fresh: false }
  const calls: string[] = []
  const input = {
    snapshot: async () => ({ ...state }),
    prepared: async () => ({ ...candidate }),
    connect: async (check: () => void) => {
      check()
      calls.push("connect")
      state.configured = true
      return true
    },
    notes: async (check: () => void) => {
      check()
      calls.push("notes")
      state.index = "approved"
      return true
    },
    index: async (check: () => void) => {
      check()
      calls.push("index")
      state.index = "synced"
      return true
    },
    capture: async (check: () => void) => {
      check()
      calls.push("capture")
      state.capture = "ready"
      return true
    },
  }
  const flow = new SetupFlow(input)
  const run = (command: Parameters<SetupFlow["run"]>[0], scope = "conversation") =>
    flow.run(command, scope, "C:/Synthetic", new AbortController().signal, () => {})
  return { state, candidate, calls, input, flow, run }
}

test("Memory setup uses stable Ask choices, completes each stage once and reports observed flags", async () => {
  const { run, calls } = fixture()
  const first = await run({ stage: "inspect", model: { providerID: "ollama", modelID: "selected" } })
  expect(first.question?.options[0].id).toBe("use_prepared")
  expect((await run({ stage: "inspect" })).attempt).toBe(first.attempt)
  const attempt = first.attempt
  const notes = await run({ stage: "continue", attempt, choice: "use_prepared" })
  expect(notes.question?.options[0].id).toBe("choose_notes")
  const index = await run({ stage: "continue", attempt, choice: "choose_notes" })
  expect(index.question?.options[0].id).toBe("index_notes")
  const capture = await run({ stage: "continue", attempt, choice: "index_notes" })
  expect(capture.question?.options[0].id).toBe("enable_capture")
  const result = await run({ stage: "continue", attempt, choice: "enable_capture" })
  expect(result.status).toBe("configured")
  expect(result.capture).toBe("ready")
  expect(result.detail).toContain("still need verification")
  expect(calls).toEqual(["connect", "notes", "index", "capture"])
  await expect(run({ stage: "continue", attempt, choice: "enable_capture" })).rejects.toThrow("expired or changed")
})

test("Memory setup refuses changed conversation and prepared selection before admission", async () => {
  const { run, candidate, calls } = fixture()
  const first = await run({ stage: "inspect" })
  await expect(run({ stage: "continue", attempt: first.attempt, choice: "use_prepared" }, "other")).rejects.toThrow(
    "expired or changed",
  )
  candidate.identity = "replacement"
  await expect(run({ stage: "continue", attempt: first.attempt, choice: "use_prepared" })).rejects.toThrow(
    "selection changed",
  )
  expect(calls).toEqual([])
  expect((await run({ stage: "inspect" })).status).toBe("choice")
})

test("A failed preparation closes its lost attempt so setup can resume immediately", async () => {
  const { input, run } = fixture()
  const original = input.prepared
  input.prepared = async () => {
    throw new Error("Invalid prepared metadata")
  }
  await expect(run({ stage: "inspect" })).rejects.toThrow("Invalid prepared metadata")
  input.prepared = original
  expect((await run({ stage: "inspect" })).status).toBe("choice")
})

test("A held setup snapshot retains ownership and closes its failed attempt before retry", async () => {
  const { input, run, calls } = fixture()
  const first = await run({ stage: "inspect" })
  const original = input.snapshot
  const held = Promise.withResolvers<Awaited<ReturnType<typeof original>>>()
  const entered = Promise.withResolvers<void>()
  input.snapshot = async () => {
    entered.resolve()
    return held.promise
  }
  const active = run({ stage: "continue", attempt: first.attempt, choice: "use_prepared" })
  await entered.promise
  await expect(run({ stage: "inspect" })).rejects.toThrow("Resume or cancel the original")
  held.reject(new Error("Snapshot unavailable"))
  await expect(active).rejects.toThrow("Snapshot unavailable")
  input.snapshot = original
  await expect(run({ stage: "continue", attempt: first.attempt, choice: "use_prepared" })).rejects.toThrow(
    "expired or changed",
  )
  const next = await run({ stage: "inspect" })
  expect(next.attempt).not.toBe(first.attempt)
  expect(next.question?.options[0].id).toBe("choose_notes")
  expect(calls).toEqual(["connect"])
})

test("A configured but unconfirmed generation enters reviewed fresh recovery before note selection", async () => {
  const { input, run, state, candidate, calls } = fixture()
  state.configured = true
  state.recovery = true
  candidate.fresh = true
  const original = input.connect
  input.connect = async (check) => {
    const accepted = await original(check)
    state.recovery = false
    return accepted
  }
  const first = await run({ stage: "inspect" })
  expect(first.configured).toBe(true)
  expect(first.question?.options[0].id).toBe("use_prepared")
  expect("recovery" in first).toBe(false)
  const next = await run({ stage: "continue", attempt: first.attempt, choice: "use_prepared" })
  expect(next.question?.options[0].id).toBe("choose_notes")
  expect(calls).toEqual(["connect"])
})

test("Cancelling a held native step fences publication and preserves the completed conversation", async () => {
  const { input, run, state } = fixture()
  const first = await run({ stage: "inspect" })
  const held = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  input.connect = async (check) => {
    entered.resolve()
    await held.promise
    check()
    state.configured = true
    return true
  }
  const active = run({ stage: "continue", attempt: first.attempt, choice: "use_prepared" })
  await entered.promise
  expect((await run({ stage: "cancel", attempt: first.attempt })).status).toBe("cancelled")
  held.resolve()
  await expect(active).rejects.toThrow("cancelled or expired")
  expect(state.configured).toBe(false)
  expect((await run({ stage: "inspect" })).status).toBe("choice")
})

test("An aborted capture step cannot publish consent after its native confirmation", async () => {
  const { input, state, flow } = fixture()
  state.configured = true
  state.index = "synced"
  const controller = new AbortController()
  const first = await flow.run(
    { stage: "inspect", model: { providerID: "ollama", modelID: "selected" } },
    "conversation",
    "C:/Synthetic",
    controller.signal,
    () => {},
  )
  const held = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  input.capture = async (check) => {
    entered.resolve()
    await held.promise
    check()
    state.capture = "ready"
    return true
  }
  const active = flow.run(
    { stage: "continue", attempt: first.attempt, choice: "enable_capture" },
    "conversation",
    "C:/Synthetic",
    controller.signal,
    () => {},
  )
  await entered.promise
  controller.abort()
  held.resolve()
  await expect(active).rejects.toThrow()
  expect(state.capture).toBe("unavailable")
})
