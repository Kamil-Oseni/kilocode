import { expect, test } from "bun:test"
import { createRoot, createSignal, createEffect } from "solid-js"
import { isServer } from "solid-js/web"
import { dispatch } from "../../webview-ui/src/utils/message-dispatch"
import { DurableDrafts } from "../../webview-ui/src/utils/durable-drafts"
import { draftNotice } from "../../webview-ui/src/utils/draft-notice"
import { draftStorage } from "../fixtures/durable-draft-storage"
import type {
  ComposerDraftExtensionMessage,
  ComposerDraftRequest,
  ComposerDraftWebviewMessage,
  DraftContent,
  DraftTarget,
} from "../../src/shared/composer-drafts-messages"

const identity: DraftTarget = {
  box: "sidebar:new-task",
  key: "sidebar:new-task:pending:sidebar-pending:test",
  pendingID: "sidebar-pending:test",
}
const rich: DraftContent = {
  text: "  Learn violin\n你好 🎻  ",
  comments: [{ id: "review", file: "src/a.ts", side: "additions", line: 1, comment: "Keep this", selectedText: "x()" }],
  images: [{ id: "image", filename: "violin.png", mime: "image/png", dataUrl: "data:image/png;base64,aGVsbG8=" }],
  scroll: 43,
  selection: { start: 2, end: 7 },
  model: { providerID: "missing-local", modelID: "missing-model" },
  agent: "plan",
  variant: "high",
}
function gate() {
  const state = Promise.withResolvers<void>()
  return { wait: state.promise, open: () => state.resolve() }
}

test("pending creation preserves the exact unowned context cache during session promotion", async () => {
  await using storage = await draftStorage()
  using view = pane(storage, 1000, undefined, false)
  view.controller.context(identity.box, "workspace-A")
  view.controller.edit(identity, rich)
  const next = { box: identity.box, key: `${identity.box}:session:voice-created`, sessionID: "voice-created" }
  view.controller.created(identity.pendingID!, next.sessionID, identity.box)
  expect(view.controller.view(next).content).toEqual(rich)
  expect(view.controller.view(next).loaded).toBe(false)
  expect(view.requests).toHaveLength(0)
})

test("pending creation cannot adopt an unowned draft from a previous workspace context", async () => {
  await using storage = await draftStorage()
  using view = pane(storage, 1000, undefined, false)
  view.controller.context(identity.box, "workspace-A")
  view.controller.edit(identity, rich)
  view.controller.context(identity.box, "workspace-B")
  const next = { box: identity.box, key: `${identity.box}:session:voice-created`, sessionID: "voice-created" }
  view.controller.created(identity.pendingID!, next.sessionID, identity.box)
  expect(view.controller.view(next).content.text).toBe("")
  view.controller.context(identity.box, "workspace-A")
  expect(view.controller.view(next).content.text).toBe("")
  expect(view.controller.view(identity).content).toEqual(rich)
  expect(view.requests).toHaveLength(0)
})

test("same authoritative owner retains pending promotion after workspace context re-admission", async () => {
  await using storage = await draftStorage()
  using view = pane(storage)
  await until(() => view.controller.ready())
  view.controller.context(identity.box, "workspace-A")
  await view.controller.hydrate(identity)
  view.controller.edit(identity, rich)
  expect(await view.controller.retry(identity)).toBe(true)
  view.controller.context(identity.box, "workspace-B")
  await until(() => view.controller.owner(identity.box) === storage.root)
  await view.controller.hydrate(identity)
  const next = { box: identity.box, key: `${identity.box}:session:voice-owned`, sessionID: "voice-owned" }
  view.controller.created(identity.pendingID!, next.sessionID, identity.box)
  expect(view.controller.view(next).content).toEqual(rich)
  expect(await view.controller.retry(next)).toBe(true)
  expect(view.controller.view(next).content).toEqual(rich)
  const base = { owner: storage.root, epoch: view.controller.epoch, generation: 1 }
  const saved = await storage.handle({
    ...base,
    type: "composerDraftLoad",
    identity: next,
    requestID: crypto.randomUUID(),
  })
  expect(saved.entry?.content).toEqual(rich)
  const previous = await storage.handle({
    ...base,
    type: "composerDraftLoad",
    identity,
    requestID: crypto.randomUUID(),
  })
  expect(previous.entry?.content ?? null).toBeNull()
})
async function until(check: () => boolean) {
  const end = Date.now() + 5000
  while (!check()) {
    if (Date.now() >= end) throw new Error("Draft test condition timed out")
    await Bun.sleep(5)
  }
}
function pane(
  storage: Awaited<ReturnType<typeof draftStorage>>,
  timeout = 1000,
  owners?: Map<string, Awaited<ReturnType<typeof draftStorage>>>,
  ready = true,
) {
  const handlers = new Set<(message: ComposerDraftExtensionMessage) => void>()
  const requests: ComposerDraftRequest[] = []
  const replies: ComposerDraftWebviewMessage[] = []
  const controls: {
    pause?: ReturnType<typeof gate>
    load?: ReturnType<typeof gate>
    clear?: ReturnType<typeof gate>
    drop?: boolean
    owner?: string
  } = {}
  const emit = (message: ComposerDraftExtensionMessage) => {
    for (const handler of handlers) handler(message)
  }
  const controller = new DurableDrafts(
    {
      onMessage(handler) {
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
      postMessage(message) {
        if (message.type === "composerDraftPane") {
          if (message.active && ready)
            queueMicrotask(() =>
              emit({
                type: "composerDraftState",
                epoch: message.epoch,
                generation: 1,
                owners: [{ box: identity.box, owner: controls.owner ?? storage.root }],
                connected: true,
              }),
            )
          return
        }
        if (message.type === "composerDraftFlushed") {
          replies.push(message)
          return
        }
        requests.push(message)
        const pause =
          message.type === "composerDraftSave"
            ? controls.pause
            : message.type === "composerDraftLoad"
              ? controls.load
              : message.type === "composerDraftClear"
                ? controls.clear
                : undefined
        void (async () => {
          if (pause) await pause.wait
          const result = await (owners?.get(message.owner) ?? storage).handle(message)
          if (message.type === "composerDraftSave" && controls.drop) {
            controls.drop = false
            return
          }
          emit(result)
        })()
      },
    },
    timeout,
  )
  return {
    controller,
    controls,
    requests,
    replies,
    emit,
    [Symbol.dispose]() {
      controller.dispose()
    },
  }
}

test("capture distinguishes an untouched unscoped rendered composer from an unowned edit", async () => {
  await using storage = await draftStorage()
  using state = pane(storage)
  await until(() => state.controller.ready())
  const target = { box: "unobserved", key: "unobserved:pending:empty", pendingID: "empty" }
  state.controller.view(target)
  const flush = (requestID: string) =>
    state.emit({
      type: "composerDraftFlush",
      requestID,
      epoch: state.controller.epoch,
      generation: 1,
      deadline: Date.now() + 1000,
    })
  flush("empty")
  await until(() => state.replies.some((reply) => reply.type === "composerDraftFlushed" && reply.requestID === "empty"))
  expect(
    state.replies.find((reply) => reply.type === "composerDraftFlushed" && reply.requestID === "empty"),
  ).toMatchObject({ committed: true, entries: [] })
  state.controller.edit(target, rich)
  flush("edited")
  await until(() =>
    state.replies.some((reply) => reply.type === "composerDraftFlushed" && reply.requestID === "edited"),
  )
  expect(
    state.replies.find((reply) => reply.type === "composerDraftFlushed" && reply.requestID === "edited"),
  ).toMatchObject({ committed: false })
  expect(state.requests).toHaveLength(0)
  expect(state.controller.view(target).content).toEqual(rich)
})

test("timed out initial hydration retries on host readiness and retains typing", async () => {
  const handlers = new Set<(message: ComposerDraftExtensionMessage) => void>()
  const loads: ComposerDraftRequest[] = []
  const controller = new DurableDrafts(
    {
      onMessage(handler) {
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
      postMessage(message) {
        if (message.type === "composerDraftLoad") loads.push(message)
      },
    },
    20,
  )
  using cleanup = { [Symbol.dispose]: () => controller.dispose() }
  const state: ComposerDraftExtensionMessage = {
    type: "composerDraftState",
    epoch: controller.epoch,
    generation: 1,
    connected: true,
    owners: [{ box: identity.box, owner: "private-owner" }],
  }
  for (const handler of handlers) handler(state)
  await controller.hydrate(identity)
  expect(controller.view(identity)).toMatchObject({ loaded: false, error: "timeout" })
  expect(draftNotice(controller.view(identity)).action).toBe("Retry loading")
  controller.edit(identity, rich)
  await controller.hydrate(identity)
  expect(loads).toHaveLength(2)
  for (const handler of handlers) handler(state)
  expect(loads).toHaveLength(3)
  const request = loads[2]
  for (const handler of handlers)
    handler({
      type: "composerDraftResult",
      operation: "composerDraftLoad",
      requestID: request.requestID,
      owner: request.owner,
      epoch: request.epoch,
      generation: request.generation,
      entry: null,
    })
  await until(() => controller.view(identity).loaded)
  expect(controller.view(identity)).toMatchObject({ content: rich, loaded: true, error: undefined })
})

test("production disk drafts restore exact rich content and unavailable selections in a fresh pane", async () => {
  await using storage = await draftStorage()
  using first = pane(storage)
  await until(() => first.controller.ready())
  await first.controller.hydrate(identity)
  first.controller.edit(identity, rich)
  const capture = await first.controller.capture(identity)
  expect(capture).toBeDefined()
  first.controller.release(capture!)
  using next = pane(storage)
  await until(() => next.controller.ready())
  expect((await next.controller.hydrate(identity)).content).toEqual(rich)
  expect((await next.controller.list(identity.box))[0].identity.pendingID).toBe(identity.pendingID)
})

test("authoritative owners partition same-box pending drafts before hydration and never dispatch into another profile", async () => {
  await using a = await draftStorage()
  await using b = await draftStorage()
  const base = { owner: a.root, requestID: "seed", epoch: "seed", generation: 1 }
  expect(
    (await a.handle({ ...base, type: "composerDraftSave", identity, content: rich, mutation: "seed" })).entry,
  ).toBeDefined()
  using view = pane(
    a,
    1000,
    new Map([
      [a.root, a],
      [b.root, b],
    ]),
  )
  await until(() => view.controller.ready())
  const held = gate()
  view.controls.load = held
  const loading = view.controller.hydrate(identity)
  view.controller.edit(identity, { text: "A typed before hydration", comments: [], images: [], scroll: 0 })
  view.emit({
    type: "composerDraftState",
    epoch: view.controller.epoch,
    generation: 2,
    connected: true,
    owners: [{ box: identity.box, owner: b.root }],
  })
  expect(view.controller.view(identity).content.text).toBe("")
  view.controls.load = undefined
  await view.controller.hydrate(identity)
  view.controller.edit(identity, { text: "B draft", comments: [], images: [], scroll: 0 })
  const saved = (await view.controller.capture(identity))!
  expect(saved.owner).toBe(b.root)
  view.controller.release(saved)
  held.open()
  await loading
  expect(view.controller.view(identity).content.text).toBe("B draft")
  expect(
    view.requests.filter((request) => request.type === "composerDraftSave" && request.owner === b.root),
  ).toMatchObject([{ content: { text: "B draft", images: [] } }])
  view.emit({
    type: "composerDraftFlush",
    requestID: "inactive-dirty",
    epoch: view.controller.epoch,
    generation: 2,
    deadline: Date.now() + 1000,
  })
  await until(() => view.replies.length === 1)
  expect(view.replies[0]).toMatchObject({ committed: false, error: "scope" })
  view.emit({
    type: "composerDraftState",
    epoch: view.controller.epoch,
    generation: 3,
    connected: true,
    owners: [{ box: identity.box, owner: a.root }],
  })
  expect(view.controller.view(identity).content.text).toBe("A typed before hydration")
  expect(await view.controller.retry(identity)).toBe(true)
  expect(view.controller.view(identity).content).toMatchObject({
    text: "A typed before hydration",
    images: rich.images,
    model: rich.model,
  })
  expect((await b.handle({ ...base, owner: b.root, type: "composerDraftLoad", identity })).entry?.content?.text).toBe(
    "B draft",
  )
})

test("serialized CAS saves retain edits made while a real disk write is delayed", async () => {
  await using storage = await draftStorage()
  using view = pane(storage)
  await until(() => view.controller.ready())
  await view.controller.hydrate(identity)
  const held = gate()
  view.controls.pause = held
  view.controller.edit(identity, rich)
  await until(() => view.requests.some((request) => request.type === "composerDraftSave"))
  view.controller.edit(identity, { ...rich, text: "New typing after the saved snapshot" })
  held.open()
  const capture = await view.controller.capture(identity)
  expect(capture?.token.revision).toBe(2)
  expect(view.controller.view(identity).content.text).toBe("New typing after the saved snapshot")
  expect(view.requests.filter((request) => request.type === "composerDraftSave")).toHaveLength(2)
})

test("lost committed ACK reconciles normalized digest and exact mutation without another write", async () => {
  await using storage = await draftStorage()
  // The fixture drops the save ACK itself; allow the real SQL store to finish its first migration.
  using view = pane(storage, 2000)
  await until(() => view.controller.ready())
  await view.controller.hydrate(identity)
  view.controls.drop = true
  view.controller.edit(identity, rich)
  await until(() => view.controller.view(identity).error === "timeout")
  expect(await view.controller.retry(identity)).toBe(true)
  expect(view.requests.filter((request) => request.type === "composerDraftSave")).toHaveLength(1)
  expect(view.controller.view(identity).content).toEqual(rich)
})

test("real CAS conflict retains local content and refuses blind retry", async () => {
  await using storage = await draftStorage()
  using left = pane(storage)
  using right = pane(storage)
  await until(() => left.controller.ready() && right.controller.ready())
  await Promise.all([left.controller.hydrate(identity), right.controller.hydrate(identity)])
  left.controller.edit(identity, rich)
  expect(await left.controller.capture(identity)).toBeDefined()
  right.controller.edit(identity, { ...rich, text: "Competing local content" })
  await until(() => right.controller.view(identity).error === "conflict")
  expect(right.controller.view(identity).content.text).toBe("Competing local content")
  expect(await right.controller.retry(identity)).toBe(false)
  expect(right.requests.filter((request) => request.type === "composerDraftSave")).toHaveLength(1)
  const destination = {
    ...identity,
    pendingID: "sidebar-pending:recovered",
    key: `${identity.box}:pending:sidebar-pending:recovered`,
  }
  expect(await right.controller.recover(identity, destination)).toBe(true)
  expect(right.controller.view(destination).content.text).toBe("Competing local content")
  expect(right.controller.view(identity).content).toEqual(rich)
  using restarted = pane(storage)
  await until(() => restarted.controller.ready())
  expect((await restarted.controller.hydrate(destination)).content.text).toBe("Competing local content")
  expect((await restarted.controller.hydrate(identity)).content).toEqual(rich)
})

test("late initial disk hydration keeps new typing together with saved attachments and exact missing model", async () => {
  await using storage = await draftStorage()
  using first = pane(storage)
  await until(() => first.controller.ready())
  await first.controller.hydrate(identity)
  first.controller.edit(identity, rich)
  expect(await first.controller.capture(identity)).toBeDefined()
  using next = pane(storage)
  await until(() => next.controller.ready())
  const held = gate()
  next.controls.load = held
  const hydration = next.controller.hydrate(identity)
  next.controller.edit(identity, { text: "Typed before hydration", comments: [], images: [], scroll: 0 })
  held.open()
  await hydration
  expect(next.controller.view(identity).content).toMatchObject({
    text: "Typed before hydration",
    images: rich.images,
    comments: rich.comments,
    model: rich.model,
    agent: rich.agent,
    variant: rich.variant,
  })
  expect(next.requests.filter((request) => request.type === "composerDraftSave")).toHaveLength(1)
})

test("accepted pending send clears only captured revision and saves newer typing after atomic promotion", async () => {
  await using storage = await draftStorage()
  using view = pane(storage)
  await until(() => view.controller.ready())
  await view.controller.hydrate(identity)
  const held = gate()
  view.controls.pause = held
  view.controller.edit(identity, rich)
  await until(() => view.requests.some((request) => request.type === "composerDraftSave"))
  const waiting = view.controller.capture(identity)
  view.controller.edit(identity, { ...rich, text: "Typed while the first message was accepted" })
  held.open()
  const capture = (await waiting)!
  expect(capture).toBeDefined()
  const original = await storage.handle({
    owner: storage.root,
    epoch: view.controller.epoch,
    generation: 1,
    requestID: crypto.randomUUID(),
    type: "composerDraftLoad",
    identity,
  })
  expect(original.entry?.token).toEqual(capture.token)
  expect(original.entry?.content?.text).toBe(rich.text)
  const next = { box: identity.box, key: `${identity.box}:session:created`, sessionID: "created" }
  view.controller.created(identity.pendingID!, "created", identity.box)
  const base = { owner: storage.root, epoch: view.controller.epoch, generation: 1, requestID: crypto.randomUUID() }
  const moved = await storage.handle({
    ...base,
    type: "composerDraftPromote",
    from: identity,
    to: next,
    source: capture.token,
    mutation: "promote",
  })
  expect(moved.target).toBeDefined()
  const cleared = await storage.handle({
    ...base,
    type: "composerDraftClear",
    identity: next,
    expected: moved.target!.token,
    mutation: "accepted",
  })
  view.emit({
    type: "composerDraftAccepted",
    epoch: view.controller.epoch,
    generation: 1,
    sessionID: "created",
    messageID: "actual-user",
    capture,
    entry: cleared.entry ?? undefined,
  })
  expect((await view.controller.hydrate(next)).content.text).toBe("Typed while the first message was accepted")
  const saved = await storage.handle({ ...base, type: "composerDraftLoad", identity: next })
  expect(saved.entry?.content?.text).toBe("Typed while the first message was accepted")
  expect(view.requests.filter((request) => request.type === "composerDraftSave")).toHaveLength(2)
})

test("flush acknowledges committed disk snapshots and refuses changes after its cutoff", async () => {
  await using storage = await draftStorage()
  using view = pane(storage)
  await until(() => view.controller.ready())
  await view.controller.hydrate(identity)
  view.controller.edit(identity, rich)
  const saved = (await view.controller.capture(identity))!
  view.controller.release(saved)
  view.emit({
    type: "composerDraftFlush",
    requestID: "stable",
    epoch: view.controller.epoch,
    generation: 1,
    deadline: Date.now() + 1000,
  })
  await until(() => view.replies.length === 1)
  expect(view.replies[0]).toMatchObject({ committed: true, entries: [{ token: saved.token, digest: saved.digest }] })
  const held = gate()
  view.controls.pause = held
  view.controller.edit(identity, { ...rich, text: "Before cutoff" })
  view.emit({
    type: "composerDraftFlush",
    requestID: "changed",
    epoch: view.controller.epoch,
    generation: 1,
    deadline: Date.now() + 1000,
  })
  view.controller.edit(identity, { ...rich, text: "After cutoff" })
  held.open()
  await until(() => view.replies.length === 2)
  expect(view.replies[1]).toMatchObject({ committed: false, error: "changed", entries: [] })
})

test("first-owner hydration never adopts a draft typed in another UI context", async () => {
  let project = "A"
  await using storage = await draftStorage({ projectID: () => project })
  using view = pane(storage, 1000, undefined, false)
  view.controller.context(identity.box, "A")
  view.controller.edit(identity, rich)
  view.controller.context(identity.box, "B")
  project = "B"
  view.emit({
    type: "composerDraftState",
    epoch: view.controller.epoch,
    generation: 3,
    connected: true,
    owners: [{ box: identity.box, owner: "owner-B" }],
  })
  expect(view.controller.view(identity).content.text).toBe("")
  await view.controller.hydrate(identity)
  expect(view.requests.filter((request) => request.type === "composerDraftSave")).toHaveLength(0)
  view.controller.context(identity.box, "A")
  project = "A"
  view.emit({
    type: "composerDraftState",
    epoch: view.controller.epoch,
    generation: 4,
    connected: true,
    owners: [{ box: identity.box, owner: "owner-A" }],
  })
  expect(view.controller.view(identity).content).toEqual(rich)
  const capture = await view.controller.capture(identity)
  expect(capture?.owner).toBe("owner-A")
  view.controller.release(capture!)
  project = "B"
  expect(
    (
      await storage.handle({
        type: "composerDraftList",
        box: identity.box,
        owner: "owner-B",
        requestID: "B",
        epoch: "test",
        generation: 4,
      })
    ).entries,
  ).toEqual([])
})

test("explicit durable discard leaves a tombstone and never removes newer typing", async () => {
  await using storage = await draftStorage()
  using view = pane(storage)
  await until(() => view.controller.ready())
  view.controller.edit(identity, rich)
  const capture = await view.controller.capture(identity)
  view.controller.release(capture!)
  expect(await view.controller.discard(identity)).toBe(true)
  using next = pane(storage)
  await until(() => next.controller.ready())
  expect((await next.controller.list(identity.box)).filter((entry) => entry.content)).toEqual([])
  expect((await next.controller.hydrate(identity)).content.text).toBe("")
  next.controller.edit(identity, rich)
  const saved = await next.controller.capture(identity)
  next.controller.release(saved!)
  const held = gate()
  next.controls.clear = held
  const clearing = next.controller.discard(identity)
  await until(() => next.requests.some((request) => request.type === "composerDraftClear"))
  next.controller.edit(identity, { ...rich, text: "Typing while discard commits" })
  held.open()
  expect(await clearing).toBe(false)
  const latest = await next.controller.capture(identity)
  expect(latest).toBeDefined()
  using restored = pane(storage)
  await until(() => restored.controller.ready())
  expect((await restored.controller.hydrate(identity)).content.text).toBe("Typing while discard commits")
})

test("captured asynchronous attachment refuses flush and retains original owner after scope changes", async () => {
  await using a = await draftStorage()
  await using b = await draftStorage()
  using view = pane(
    a,
    1000,
    new Map([
      [a.root, a],
      [b.root, b],
    ]),
  )
  await until(() => view.controller.ready())
  await view.controller.hydrate(identity)
  view.controller.edit(identity, { ...rich, images: [] })
  const destination = view.controller.destination(identity)
  expect(await view.controller.capture(identity)).toBeUndefined()
  view.emit({
    type: "composerDraftFlush",
    requestID: "reading",
    epoch: view.controller.epoch,
    generation: 1,
    deadline: Date.now() + 1000,
  })
  await until(() => view.replies.length === 1)
  expect(view.replies[0]).toMatchObject({ committed: false, error: "unavailable" })
  view.emit({
    type: "composerDraftState",
    epoch: view.controller.epoch,
    generation: 2,
    connected: true,
    owners: [{ box: identity.box, owner: b.root }],
  })
  await view.controller.hydrate(identity)
  view.controller.edit(identity, { text: "B", comments: [], images: [], scroll: 0 })
  expect(destination.append(rich.images[0], identity)).toBeUndefined()
  expect(view.controller.view(identity).content.images).toEqual([])
  view.emit({
    type: "composerDraftState",
    epoch: view.controller.epoch,
    generation: 3,
    connected: true,
    owners: [{ box: identity.box, owner: a.root }],
  })
  const capture = await view.controller.capture(identity)
  expect(capture).toBeDefined()
  view.controller.release(capture!)
  using restored = pane(a)
  await until(() => restored.controller.ready())
  expect((await restored.controller.hydrate(identity)).content).toEqual(rich)
})

test("context invalidation requests fresh authoritative ownership before loading a new pending draft", async () => {
  await using a = await draftStorage()
  await using b = await draftStorage()
  using view = pane(
    a,
    1000,
    new Map([
      [a.root, a],
      [b.root, b],
    ]),
  )
  view.controller.context(identity.box, "A")
  await until(() => view.controller.owner(identity.box) === a.root)
  await view.controller.hydrate(identity)
  view.controller.edit(identity, rich)
  expect(await view.controller.retry(identity)).toBe(true)
  view.controls.owner = b.root
  view.controller.context(identity.box, "B")
  expect(view.controller.owner(identity.box)).toBeUndefined()
  await until(() => view.controller.owner(identity.box) === b.root)
  await view.controller.hydrate(identity)
  expect(view.controller.view(identity).loaded).toBe(true)
  expect(view.controller.view(identity).content.text).toBe("")
  expect(
    view.requests.filter((request) => request.owner === b.root && request.type === "composerDraftSave"),
  ).toHaveLength(0)
  view.controller.edit(identity, { text: "B only", comments: [], images: [], scroll: 0 })
  expect(await view.controller.retry(identity)).toBe(true)
  view.controls.owner = a.root
  view.controller.context(identity.box, "A")
  await until(() => view.controller.owner(identity.box) === a.root)
  await view.controller.hydrate(identity)
  expect(view.controller.view(identity).content).toEqual(rich)
})

test("accepted pending Ask send clears consumed payload while preserving a post-send picker edit", async () => {
  await using storage = await draftStorage()
  using view = pane(storage)
  await until(() => view.controller.ready())
  await view.controller.hydrate(identity)
  const content = { ...rich, agent: "ask", model: { providerID: "qwen-local", modelID: "qwen3-raya-32k:latest" } }
  view.controller.edit(identity, content)
  const capture = (await view.controller.capture(identity))!
  expect(capture).toBeDefined()
  const next = { box: identity.box, key: `${identity.box}:session:ask-created`, sessionID: "ask-created" }
  view.controller.created(identity.pendingID!, next.sessionID, identity.box)
  const base = { owner: storage.root, epoch: view.controller.epoch, generation: 1, requestID: crypto.randomUUID() }
  const moved = await storage.handle({
    ...base,
    type: "composerDraftPromote",
    from: identity,
    to: next,
    source: capture.token,
    mutation: "send:ask-user",
  })
  expect(moved.target).toBeDefined()
  view.emit({
    type: "composerDraftPrepared",
    epoch: view.controller.epoch,
    generation: 1,
    sessionID: next.sessionID,
    messageID: "ask-user",
    capture,
    entry: moved.target!,
  })
  // A genuine picker edit after sending remains a local draft change.
  view.controller.edit(next, { ...content, agent: "auto", model: { providerID: "kilo-auto", modelID: "free" } })
  const cleared = await storage.handle({
    ...base,
    type: "composerDraftClear",
    identity: next,
    expected: moved.target!.token,
    mutation: "accepted:ask-user",
  })
  view.emit({
    type: "composerDraftAccepted",
    epoch: view.controller.epoch,
    generation: 1,
    sessionID: next.sessionID,
    messageID: "ask-user",
    capture,
    entry: cleared.entry ?? undefined,
  })
  const state = await view.controller.hydrate(next)
  expect(state.content.text).toBe("")
  expect(state.content.comments).toEqual([])
  expect(state.content.images).toEqual([])
  expect(state.content.agent).toBe("auto")
  expect(state.content.model).toEqual({ providerID: "kilo-auto", modelID: "free" })
  const saved = await storage.handle({ ...base, type: "composerDraftLoad", identity: next })
  expect(saved.entry?.content?.text).toBe("")
})
test("message dispatch preserves captured Ask draft through reactive promotion into real storage", async () => {
  if (isServer) {
    const child = Bun.spawn(
      [process.execPath, "--conditions=browser", "test", import.meta.path, "--test-name-pattern", "reactive promotion"],
      { stdout: "pipe", stderr: "pipe", windowsHide: true },
    )
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, out + err).toBe(0)
    return
  }
  await using storage = await draftStorage()
  using view = pane(storage)
  await until(() => view.controller.ready())
  await view.controller.hydrate(identity)
  const content = { ...rich, agent: "ask", model: { providerID: "qwen-local", modelID: "qwen3-raya-32k:latest" } }
  view.controller.edit(identity, content)
  const capture = (await view.controller.capture(identity))!
  const next = { box: identity.box, key: `${identity.box}:session:batched-ask`, sessionID: "batched-ask" }
  const base = { owner: storage.root, epoch: view.controller.epoch, generation: 1, requestID: crypto.randomUUID() }
  const moved = await storage.handle({
    ...base,
    type: "composerDraftPromote",
    from: identity,
    to: next,
    source: capture.token,
    mutation: "send:batched-ask-user",
  })
  expect(moved.target).toBeDefined()
  view.emit({
    type: "composerDraftPrepared",
    epoch: view.controller.epoch,
    generation: 1,
    sessionID: next.sessionID,
    messageID: "batched-ask-user",
    capture,
    entry: moved.target!,
  })
  const reactive = createRoot((dispose) => {
    const [choice, setChoice] = createSignal(content)
    const seen: string[] = []
    createEffect(() => {
      const value = choice()
      seen.push(value.agent)
      view.controller.edit(next, value)
    })
    return { dispose, seen, setChoice }
  })
  await Bun.sleep(0)
  const handlers = new Set<() => void>([
    () => reactive.setChoice({ ...content, agent: "auto", model: { providerID: "kilo-auto", modelID: "free" } }),
    () => reactive.setChoice(content),
  ])
  try {
    expect(reactive.seen).toEqual(["ask"])
    dispatch(handlers, undefined)
    expect(reactive.seen).toEqual(["ask", "ask"])
    const cleared = await storage.handle({
      ...base,
      type: "composerDraftClear",
      identity: next,
      expected: moved.target!.token,
      mutation: "accepted:batched-ask-user",
    })
    view.emit({
      type: "composerDraftAccepted",
      epoch: view.controller.epoch,
      generation: 1,
      sessionID: next.sessionID,
      messageID: "batched-ask-user",
      capture,
      entry: cleared.entry ?? undefined,
    })
    const state = await view.controller.hydrate(next)
    expect(state.content.text).toBe("")
    expect(state.content.comments).toEqual([])
    expect(state.content.images).toEqual([])
    const saved = await storage.handle({ ...base, type: "composerDraftLoad", identity: next })
    expect(saved.entry?.content ?? null).toBeNull()
  } finally {
    reactive.dispose()
  }
})
test("accepted speech send clears consumed text after caret-only changes", async () => {
  await using storage = await draftStorage()
  using view = pane(storage)
  await until(() => view.controller.ready())
  await view.controller.hydrate(identity)
  const content = { ...rich, agent: "ask", model: { providerID: "qwen-local", modelID: "qwen3-raya-32k:latest" } }
  view.controller.edit(identity, content)
  const capture = (await view.controller.capture(identity))!
  expect(capture).toBeDefined()
  const next = { box: identity.box, key: `${identity.box}:session:ask-created`, sessionID: "ask-created" }
  view.controller.created(identity.pendingID!, next.sessionID, identity.box)
  const base = { owner: storage.root, epoch: view.controller.epoch, generation: 1, requestID: crypto.randomUUID() }
  const moved = await storage.handle({
    ...base,
    type: "composerDraftPromote",
    from: identity,
    to: next,
    source: capture.token,
    mutation: "send:ask-user",
  })
  expect(moved.target).toBeDefined()
  view.emit({
    type: "composerDraftPrepared",
    epoch: view.controller.epoch,
    generation: 1,
    sessionID: next.sessionID,
    messageID: "ask-user",
    capture,
    entry: moved.target!,
  })
  // A genuine picker edit after sending remains a local draft change.
  view.controller.edit(next, {
    ...content,
    selection: { start: content.text.length, end: content.text.length },
    scroll: 0,
  })
  const cleared = await storage.handle({
    ...base,
    type: "composerDraftClear",
    identity: next,
    expected: moved.target!.token,
    mutation: "accepted:ask-user",
  })
  view.emit({
    type: "composerDraftAccepted",
    epoch: view.controller.epoch,
    generation: 1,
    sessionID: next.sessionID,
    messageID: "ask-user",
    capture,
    entry: cleared.entry ?? undefined,
  })
  const state = await view.controller.hydrate(next)
  expect(state.content.text).toBe("")
  expect(state.content.comments).toEqual([])
  expect(state.content.images).toEqual([])
})
