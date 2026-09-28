import { expect, test } from "bun:test"
import { OpenAIHistory } from "../../src/speech/openai-history"

function fixture() {
  const history = new OpenAIHistory()
  const events: Record<string, unknown>[] = []
  const controller = new AbortController()
  const append = (
    items: { itemID: string; role: "user" | "assistant"; text: string }[],
    revision: number,
    incomplete = false,
  ) =>
    history.append(
      { version: 1, sourceRevision: revision, sourceHash: String(revision).padStart(64, "0"), incomplete, items },
      (event) => {
        events.push(event)
        history.receive({ type: "conversation.item.created", item: event.item })
      },
      () => undefined,
      controller.signal,
    )
  const packet = (index: number) => JSON.parse((events[index].item as { content: { text: string }[] }).content[0].text)
  return { history, events, controller, append, packet }
}

test("candidate context appends changed semantic rows and invalidations without provenance or repeated text", async () => {
  const f = fixture()
  const first = { itemID: "private_provider_item", role: "user" as const, text: "Historical violin request" }
  const second = { itemID: "private_provider_reply", role: "assistant" as const, text: "Historical reply" }
  await f.append([first, second], 1)
  const initial = f.packet(0)
  expect(initial.changes).toHaveLength(2)
  expect(JSON.stringify(initial)).not.toContain("private_provider")
  await f.append([first, second], 2)
  expect(f.events).toHaveLength(1)
  await f.append([first, { ...second, text: "Corrected reply" }], 3)
  const changed = f.packet(1)
  expect(changed.changes).toHaveLength(1)
  expect(changed.changes[0]).toMatchObject({
    role: "assistant",
    text: "Corrected reply",
    supersedes: [initial.changes[1].id],
  })
  expect(JSON.stringify(changed)).not.toContain(first.text)
  await f.append([first], 4, true)
  expect(f.packet(2).changes).toEqual([{ id: expect.any(String), supersedes: [changed.changes[0].id], omitted: true }])
  expect(f.packet(2).incomplete).toBe(true)
})

test("changed acknowledgement refuses advancement and cancellation cannot synthesize readiness", async () => {
  const history = new OpenAIHistory()
  const controller = new AbortController()
  const context = { version: 1, sourceRevision: 1, sourceHash: "a".repeat(64), incomplete: false, items: [] }
  await expect(
    history.append(
      context,
      (event) => {
        history.receive({ type: "conversation.item.created", item: { ...(event.item as object), role: "assistant" } })
      },
      () => undefined,
      controller.signal,
    ),
  ).rejects.toThrow("acknowledgement changed")
  const pending = history.append(
    context,
    () => undefined,
    () => undefined,
    controller.signal,
  )
  controller.abort()
  await expect(pending).rejects.toThrow("not confirmed")
})

test("candidate context refuses duplicate provenance and oversized semantic deltas", async () => {
  const f = fixture()
  const row = { itemID: "item", role: "user" as const, text: "hello" }
  await expect(f.append([row, row], 1)).rejects.toThrow("repeats")
  await expect(f.append([{ ...row, text: "x".repeat(4097) }], 2)).rejects.toThrow("invalid text")
  await expect(
    f.append(
      Array.from({ length: 4 }, (_, index) => ({ ...row, itemID: `item_${index}`, text: "x".repeat(4096) })),
      3,
    ),
  ).rejects.toThrow("boundary")
  expect(f.events).toHaveLength(0)
})

test("reordered semantic memories require a new exact receipt even when text is unchanged", async () => {
  const f = fixture()
  const first = { itemID: "first", role: "user" as const, text: "First" }
  const second = { itemID: "second", role: "assistant" as const, text: "Second" }
  await f.append([first, second], 1)
  const initial = f.packet(0)
  await f.append([second, first], 2)
  expect(f.packet(1).changes).toEqual([])
  expect(f.packet(1).order).toEqual([...initial.order].reverse())
  await f.append([first], 3)
  expect(f.packet(2).order).toEqual([initial.order[0]])
  expect(f.packet(2).changes[0].supersedes).toEqual([initial.order[1]])
})

test("synchronous transport failure clears pending acknowledgement before another append", async () => {
  const history = new OpenAIHistory()
  const context = { version: 1, sourceRevision: 1, sourceHash: "a".repeat(64), incomplete: false, items: [] }
  await expect(
    history.append(
      context,
      () => {
        throw new Error("Disconnected transport")
      },
      () => undefined,
      new AbortController().signal,
    ),
  ).rejects.toThrow("Disconnected")
  await history.append(
    context,
    (event) => {
      history.receive({ type: "conversation.item.created", item: event.item })
    },
    () => undefined,
    new AbortController().signal,
  )
})

test("settling an acknowledged append cannot erase the next pending receipt", async () => {
  const history = new OpenAIHistory()
  const controller = new AbortController()
  const events: Record<string, unknown>[] = []
  const promises: Promise<void>[] = []
  const context = { version: 1, sourceRevision: 1, sourceHash: "a".repeat(64), incomplete: false, items: [] }
  const send = (event: Record<string, unknown>) => {
    events.push(event)
  }
  try {
    promises.push(history.append(context, send, () => undefined, controller.signal))
    expect(history.receive({ type: "conversation.item.done", item: events[0].item })).toBe(true)
    promises.push(
      history.append(
        { ...context, sourceRevision: 2, sourceHash: "b".repeat(64), incomplete: true },
        send,
        () => undefined,
        controller.signal,
      ),
    )
    const observed = promises[1].then(
      () => true,
      () => false,
    )
    await promises[0]
    expect(events).toHaveLength(2)
    expect(history.receive({ type: "conversation.item.done", item: events[1].item })).toBe(true)
    expect(await observed).toBe(true)
    expect(history.receive({ type: "conversation.item.done", item: events[0].item })).toBe(false)
  } finally {
    controller.abort()
    await Promise.allSettled(promises)
  }
})
