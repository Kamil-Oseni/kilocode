import { expect, test } from "bun:test"
import { entry } from "../../src/second-brain/dream-entry"
import type { BrainResponse } from "../../src/shared/second-brain"
import { DreamActivity } from "../../src/second-brain/dream-activity"

test("Memory entry invokes only the fixed native review command and reports closure without success", async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const commands: string[] = []
  const responses: BrainResponse[] = []
  const work = entry(
    { type: "secondBrain", action: "dreamStart", id: "original" },
    async (command) => {
      commands.push(command)
      await held
    },
    (response) => responses.push(response),
  )
  expect(commands).toEqual(["raya.memory.startDream"])
  expect(responses.map((response) => response.state.dream?.status)).toEqual(["native-review"])
  release()
  expect(await work).toBe(true)
  expect(responses.map((response) => response.state.dream?.status)).toEqual(["native-review", "closed"])
  expect(responses.every((response) => response.id === "original" && !response.state.proposals)).toBe(true)
})

test("entry refuses webview-supplied authority and does not invoke unrelated commands", async () => {
  const commands: string[] = []
  const execute = async (command: string) => {
    commands.push(command)
  }
  const responses: BrainResponse[] = []
  for (const field of ["model", "project", "sources", "targets", "command", "approved"]) {
    expect(
      await entry(
        { type: "secondBrain", action: "dreamStart", id: "original", [field]: "untrusted" },
        execute,
        (response) => responses.push(response),
      ),
    ).toBe(true)
  }
  expect(
    await entry({ type: "secondBrain", action: "dreamInspect", id: "" }, execute, (response) =>
      responses.push(response),
    ),
  ).toBe(true)
  expect(
    await entry({ type: "secondBrain", action: "search", id: "original" }, execute, (response) =>
      responses.push(response),
    ),
  ).toBe(false)
  expect(commands).toEqual([])
  expect(responses).toEqual([])
})

test("inspection uses its fixed read-only command and failed native reviews remain unavailable", async () => {
  const commands: string[] = []
  const responses: BrainResponse[] = []
  await entry(
    { type: "secondBrain", action: "dreamInspect", id: "original" },
    async (command) => {
      commands.push(command)
      throw new Error("Synthetic native review refusal")
    },
    (response) => responses.push(response),
  )
  expect(commands).toEqual(["raya.memory.inspectDream"])
  expect(responses.map((response) => response.state.dream?.status)).toEqual(["native-review", "unavailable"])
})

test("activity queries and exact-run cancellation route to their original native commands", async () => {
  const view = new DreamActivity()
  const selected = {
    id: crypto.randomUUID(),
    owner: crypto.randomUUID(),
    project: "C:/Synthetic",
    model: "fixture/model",
  }
  const controller = new AbortController()
  view.begin(selected, controller)
  const commands: string[] = []
  const responses: BrainResponse[] = []
  const execute: Parameters<typeof entry>[1] = async (command, target) => {
    commands.push(command)
    if (command === "raya.memory.cancelDream") view.cancel(target)
    return view.snapshot()
  }
  await entry({ type: "secondBrain", action: "dreamActivity", id: "read" }, execute, (response) =>
    responses.push(response),
  )
  expect(responses.at(-1)?.state.dream?.activity).toMatchObject({ ...selected, lifecycle: "active" })
  await entry(
    { type: "secondBrain", action: "dreamCancel", id: "cancel", target: { id: selected.id, owner: selected.owner } },
    execute,
    (response) => responses.push(response),
  )
  expect(commands).toEqual(["raya.memory.dreamActivity", "raya.memory.cancelDream"])
  expect(controller.signal.aborted).toBe(true)
  expect(responses.at(-1)?.state.dream?.activity?.lifecycle).toBe("settling")
  await entry(
    {
      type: "secondBrain",
      action: "dreamCancel",
      id: "invalid",
      target: { id: selected.id, owner: selected.owner, command: "other" },
    },
    execute,
    (response) => responses.push(response),
  )
  expect(commands).toHaveLength(2)
  expect(responses.at(-1)?.state.dream?.status).toBe("unavailable")
})
