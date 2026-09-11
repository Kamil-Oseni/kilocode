import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@/session/schema"
import { RayaTaskDelegation, billed, begun, credited, ceiling, replied, scope, type Request } from "@/kilocode/task/delegation"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import type { RayaTask } from "@/kilocode/task"

const agent = (id: string, role: string, extra?: Partial<RayaTask.Agent>): RayaTask.Agent => ({
  id,
  name: id,
  role,
  objective: `${id} standing work`,
  capabilities: role === "accountant" ? ["accounting"] : [],
  memoryScope: "project",
  schedule: { kind: "manual" },
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  access: "full",
  ...extra,
})

const request = (source: string, sender: string, recipient: string, extra?: Partial<Request>): Request => ({
  source,
  senderID: sender,
  recipientID: recipient,
  objective: "Review Friday receipts and return the missing items.",
  ...extra,
})

test("delegation policy intersects access and workspace without granting broader rights", () => {
  const chief = agent("chief", "generalist", { access: "brief" })
  const books = agent("books", "accountant", { access: "full" })
  expect(ceiling(chief, books).access).toBe("brief")
  expect(ceiling(books, books).access).toBe("full")
  expect(scope(chief, books)).toBeUndefined()
  expect(scope({ dir: "/a" }, { dir: "/b" })).toBeUndefined()
  expect(scope({ dir: "/a" }, { dir: "/a/" })).toBe("/a")
})

test("posted replies do not invent a completed worker result", () => {
  const books = agent("books", "accountant")
  expect(
    replied(
      {
        id: "rdl_1",
        source: "dlg_1",
        senderID: "chief",
        recipientID: "books",
        objective: "Review receipts",
        depth: 1,
        state: "running",
        time: 1,
      },
      books,
    ),
  ).toBeUndefined()
  const done = replied(
    {
      id: "rdl_1",
      source: "dlg_1",
      senderID: "chief",
      recipientID: "books",
      objective: "Review receipts",
      depth: 1,
      state: "completed",
      time: 1,
    },
    books,
  )
  expect(done?.kind).toBe("delegation")
  expect(done?.body).toContain("not invented success")
  expect(done?.body).toContain("Child cost was not recorded. No amount was invented.")
  const priced = replied(
    {
      id: "rdl_1",
      source: "dlg_1",
      senderID: "chief",
      recipientID: "books",
      objective: "Review receipts",
      depth: 1,
      state: "completed",
      cost: 1.5,
      time: 1,
    },
    books,
  )
  expect(priced?.body).toContain("Child cost $1.5")
  expect(priced?.body).toContain("not added to the requesting worker's standing-job total")
  expect(billed({ cost: Number.NaN })).toContain("No amount was invented")
  const notes = credited(
    [
      {
        id: "rdl_done",
        source: "dlg_done",
        senderID: "chief",
        recipientID: "books",
        objective: "Review receipts",
        depth: 1,
        state: "completed",
        cost: 1.5,
        time: 1,
      },
      {
        id: "rdl_wait",
        source: "dlg_wait",
        senderID: "chief",
        recipientID: "legal",
        objective: "Confirm policy",
        depth: 1,
        state: "queued",
        time: 2,
      },
    ],
    (id) => (id === "books" ? "Accounting" : "Legal"),
  )
  expect(notes[0]).toContain("not added to this run's total")
  expect(notes.some((line) => line.includes("Accounting: completed") && line.includes("$1.5"))).toBe(true)
  expect(notes.some((line) => line.includes("Legal: queued") && line.includes("not a completed worker result"))).toBe(true)
  expect(
    begun({
      id: "rdl_1",
      source: "dlg_1",
      senderID: "chief",
      recipientID: "books",
      objective: "Review receipts",
      depth: 1,
      state: "queued",
      time: 1,
    }),
  ).toBeUndefined()
  expect(
    begun({
      id: "rdl_1",
      source: "dlg_1",
      senderID: "chief",
      recipientID: "books",
      objective: "Review receipts",
      depth: 1,
      state: "running",
      time: 1,
    })?.body,
  ).toContain("no longer only queued")
})

test("delegation admits once, refuses loops, and queues without duplicating a busy worker", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = RayaTaskDelegation.make(yield* Database.Service)
      const inbox = RayaTaskInbox.make(yield* Database.Service)
      const chief = agent("chief", "generalist")
      const books = agent("books", "accountant")
      const first = yield* store.admit(request("dlg_1", chief.id, books.id), chief, books)
      expect(first.created).toBe(true)
      expect(first.record.state).toBe("queued")
      expect(first.record.depth).toBe(1)
      expect((yield* inbox.page(chief.id)).messages.some((item) => item.body.includes("queued until the worker is free"))).toBe(
        true,
      )
      expect((yield* store.admit(request("dlg_1", chief.id, books.id), chief, books)).created).toBe(false)
      expect(
        Exit.isFailure(
          yield* store
            .admit(request("dlg_1", chief.id, books.id, { objective: "Different work" }), chief, books)
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(
        Exit.isFailure(yield* store.admit(request("dlg_self", chief.id, chief.id), chief, chief).pipe(Effect.exit)),
      ).toBe(true)
      const taken = yield* store.take(books.id)
      expect(taken?.id).toBe(first.record.id)
      expect(taken?.state).toBe("accepted")
      const sid = SessionID.make("ses_books")
      const running = yield* store.attach(taken!.id, "run_1", sid)
      expect(running.state).toBe("running")
      expect((yield* inbox.page(chief.id)).messages.some((item) => item.source.startsWith("start:") && item.body.includes("no longer only queued"))).toBe(
        true,
      )
      expect((yield* store.attach(taken!.id, "run_1", sid)).sessionID).toBe(sid)
      expect(
        Exit.isFailure(yield* store.attach(taken!.id, "run_2", sid).pipe(Effect.exit)),
      ).toBe(true)
      const done = yield* store.finish(taken!.id, "completed", books, "Travel receipts are missing.")
      expect(done.state).toBe("completed")
      expect(done.response).toBe("Travel receipts are missing.")
      expect((yield* store.finish(taken!.id, "completed", books, "Travel receipts are missing.")).state).toBe(
        "completed",
      )
      const loop = yield* store.admit(
        request("dlg_loop", books.id, chief.id, { parentID: first.record.id }),
        books,
        chief,
      ).pipe(Effect.exit)
      expect(Exit.isFailure(loop)).toBe(true)
      const paused = agent("quiet", "reviewer", { enabled: false })
      const denied = yield* store.admit(request("dlg_pause", chief.id, paused.id), chief, paused)
      expect(denied.record.state).toBe("failed")
      expect(denied.record.reason).toContain("paused")
      expect((yield* inbox.page(chief.id)).messages.some((item) => item.body.includes("paused") && item.body.includes("not a completed worker reply"))).toBe(
        true,
      )
      const extra = agent("legal", "reviewer")
      for (const n of [2, 3, 4, 5]) {
        const item = yield* store.admit(request(`dlg_root_${n}`, chief.id, extra.id), chief, extra)
        expect(item.record.state).toBe("queued")
      }
      expect(
        Exit.isFailure(
          yield* store.admit(request("dlg_root_6", chief.id, extra.id), chief, extra).pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* store
            .admit(request("dlg_dir", chief.id, books.id), agent("chief", "generalist", { dir: "/a" }), agent("books", "accountant", { dir: "/b" }))
            .pipe(Effect.exit),
        ),
      ).toBe(true)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("stopping a request keeps a completed child and does not rewrite the parent", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = RayaTaskDelegation.make(yield* Database.Service)
      const chief = agent("chief", "generalist")
      const books = agent("books", "accountant")
      const extra = agent("legal", "reviewer")
      const parent = yield* store.admit(request("dlg_open", chief.id, books.id), chief, books)
      const taken = yield* store.take(books.id)
      yield* store.attach(taken!.id, "run_open", SessionID.make("ses_open"))
      const child = yield* store.admit(
        request("dlg_child", books.id, extra.id, { parentID: parent.record.id }),
        books,
        extra,
      )
      expect((yield* store.descendants(parent.record.id)).map((item) => item.id)).toEqual([child.record.id])
      const lineage = yield* store.tree(child.record.id)
      expect(lineage.record.id).toBe(child.record.id)
      expect(lineage.above.map((item) => item.id)).toEqual([parent.record.id])
      expect(lineage.below).toEqual([])
      expect((yield* store.tree(parent.record.id)).below.map((item) => item.id)).toEqual([child.record.id])
      const halted = yield* store.stop(parent.record.id, books, "Stopped by the user.")
      expect(halted.state).toBe("cancelled")
      expect((yield* store.stop(parent.record.id, books, "Stopped by the user.")).state).toBe("cancelled")
      expect((yield* store.get(child.record.id)).state).toBe("queued")
      const kept = yield* store.finish(child.record.id, "completed", extra, "Named missing receipts.")
      expect(kept.state).toBe("completed")
      expect((yield* store.stop(child.record.id, extra, "Stopped by the user.")).state).toBe("completed")
      expect(kept.response).toBe("Named missing receipts.")
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("child cost is stored as a real amount and listed on the parent run without adding it", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = RayaTaskDelegation.make(yield* Database.Service)
      const chief = agent("chief", "generalist")
      const books = agent("books", "accountant")
      const extra = agent("legal", "reviewer")
      const first = yield* store.admit(
        request("dlg_cost", chief.id, books.id, { parentRunID: "occ_parent" }),
        chief,
        books,
      )
      const taken = yield* store.take(books.id)
      yield* store.attach(taken!.id, "run_books", SessionID.make("ses_books"))
      const done = yield* store.finish(taken!.id, "completed", books, "Travel receipts are missing.", 1.5)
      expect(done.cost).toBe(1.5)
      expect((yield* store.get(taken!.id)).cost).toBe(1.5)
      expect((yield* store.finish(taken!.id, "completed", books, "Travel receipts are missing.", 1.5)).cost).toBe(1.5)
      const waiting = yield* store.admit(
        request("dlg_pending", chief.id, extra.id, { parentRunID: "occ_parent" }),
        chief,
        extra,
      )
      expect(waiting.record.state).toBe("queued")
      const kids = yield* store.byRun("occ_parent")
      expect(kids.map((item) => item.id)).toEqual([first.record.id, waiting.record.id])
      expect(kids[0]?.cost).toBe(1.5)
      expect(kids[1]?.cost).toBeUndefined()
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("overdue live requests fail with a timeout reply", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = RayaTaskDelegation.make(yield* Database.Service)
      const inbox = RayaTaskInbox.make(yield* Database.Service)
      const chief = agent("chief", "generalist")
      const books = agent("books", "accountant")
      const due = Date.now() + 60_000
      const first = yield* store.admit(request("dlg_time", chief.id, books.id, { deadline: due }), chief, books)
      expect(first.record.state).toBe("queued")
      expect((yield* store.overdue(Date.now())).length).toBe(0)
      expect((yield* store.overdue(due)).map((item) => item.id)).toEqual([first.record.id])
      const done = yield* store.finish(first.record.id, "failed", books, undefined, undefined, "This request timed out. It was not completed.")
      expect(done.state).toBe("failed")
      expect(done.reason).toContain("timed out")
      expect((yield* inbox.page(chief.id)).messages.some((item) => item.body.includes("timed out"))).toBe(true)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})
