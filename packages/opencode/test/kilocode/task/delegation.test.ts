import { expect, test } from "bun:test"
import path from "node:path"
import { Context, Effect, Exit, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@/session/schema"
import {
  RayaTaskDelegation,
  billed,
  begun,
  credited,
  ceiling,
  replied,
  scope,
  type Request,
} from "@/kilocode/task/delegation"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import type { RayaTask } from "@/kilocode/task"
import { tmpdir } from "../../fixture/fixture"

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
  expect(ceiling(agent("sender", "generalist", { tools: ["read", "browser_*"] }), books).tools).toEqual([
    "read",
    "browser_*",
  ])
  expect(
    ceiling(
      agent("sender", "generalist", { tools: ["read", "browser_*"] }),
      agent("recipient", "generalist", { tools: ["read", "write", "browser_*"] }),
    ).tools,
  ).toEqual(["read", "browser_*"])
  expect(ceiling(agent("sender", "generalist", { tools: [] }), books).tools).toEqual([])
  expect(scope(chief, books)).toBeUndefined()
  expect(scope({ dir: "/a" }, { dir: "/b" })).toBeUndefined()
  expect(scope({ dir: "/a" }, { dir: "/a/" })).toBe("/a")
})

test("organization-scoped delegation persists admission provenance and revalidates before start", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const organizationID = "org_11111111111111111111111111111111"
      const allowed = { current: true }
      const revisions: Array<number | undefined> = []
      const policy = (input: { id: string; revision?: number; senderID: string; recipientID: string }) =>
        Effect.sync(() => revisions.push(input.revision)).pipe(
          Effect.andThen(
            allowed.current &&
              input.id === organizationID &&
              input.senderID === "chief" &&
              input.recipientID === "books" &&
              input.revision === 3
              ? Effect.succeed({ id: organizationID, name: "Website Builders", revision: 3 })
              : Effect.fail(new Error("denied")),
          ),
        )
      const store = RayaTaskDelegation.make(database, policy, () => Effect.succeed(true))
      const chief = agent("chief", "generalist")
      const books = agent("books", "accountant")
      const admitted = yield* store.admit(
        request("dlg_org", chief.id, books.id, { organizationID, organizationRevision: 3 }),
        chief,
        books,
      )
      expect(admitted.record).toMatchObject({
        organizationID,
        organizationName: "Website Builders",
        organizationRevision: 3,
      })
      const taken = (yield* store.take(books.id))!
      expect(yield* store.authorize(taken)).toBe(true)
      expect(revisions).toEqual([3, 3])
      allowed.current = false
      expect(yield* store.authorize(taken)).toBe(false)
      expect(
        Exit.isFailure(yield* store.admit(request("dlg_unscoped", chief.id, books.id), chief, books).pipe(Effect.exit)),
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* store
            .admit(request("dlg_denied", books.id, chief.id, { organizationID, organizationRevision: 3 }), books, chief)
            .pipe(Effect.exit),
        ),
      ).toBe(true)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
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
  expect(notes.some((line) => line.includes("Legal: queued") && line.includes("not a completed worker result"))).toBe(
    true,
  )
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
      expect(yield* store.used("unused")).toBe(false)
      const first = yield* store.admit(request("dlg_1", chief.id, books.id), chief, books)
      expect(first.created).toBe(true)
      expect(first.record.state).toBe("queued")
      expect(first.record.depth).toBe(1)
      expect(
        (yield* inbox.page(chief.id)).messages.some((item) => item.body.includes("queued until the worker is free")),
      ).toBe(true)
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
      expect(
        (yield* inbox.page(chief.id)).messages.some(
          (item) => item.source.startsWith("start:") && item.body.includes("no longer only queued"),
        ),
      ).toBe(true)
      expect((yield* store.attach(taken!.id, "run_1", sid)).sessionID).toBe(sid)
      expect(Exit.isFailure(yield* store.attach(taken!.id, "run_2", sid).pipe(Effect.exit))).toBe(true)
      const done = yield* store.finish(taken!.id, "completed", books, "Travel receipts are missing.")
      expect(done.state).toBe("completed")
      expect(done.response).toBe("Travel receipts are missing.")
      expect(yield* store.used(chief.id)).toBe(true)
      expect(yield* store.used(books.id)).toBe(true)
      expect((yield* store.finish(taken!.id, "completed", books, "Travel receipts are missing.")).state).toBe(
        "completed",
      )
      expect((yield* inbox.page(chief.id)).messages.filter((item) => item.source.startsWith("reply:")).length).toBe(1)
      expect(
        Exit.isFailure(yield* store.finish(taken!.id, "failed", books, "A different result.").pipe(Effect.exit)),
      ).toBe(true)
      expect((yield* inbox.page(chief.id)).messages.filter((item) => item.source.startsWith("reply:")).length).toBe(1)
      const loop = yield* store
        .admit(request("dlg_loop", books.id, chief.id, { parentID: first.record.id }), books, chief)
        .pipe(Effect.exit)
      expect(Exit.isFailure(loop)).toBe(true)
      const paused = agent("quiet", "reviewer", { enabled: false })
      const denied = yield* store.admit(request("dlg_pause", chief.id, paused.id), chief, paused)
      expect(denied.record.state).toBe("failed")
      expect(denied.record.reason).toContain("paused")
      expect(
        (yield* inbox.page(chief.id)).messages.some(
          (item) => item.body.includes("paused") && item.body.includes("not a completed worker reply"),
        ),
      ).toBe(true)
      const extra = agent("legal", "reviewer")
      for (const n of [2, 3, 4, 5]) {
        const item = yield* store.admit(request(`dlg_root_${n}`, chief.id, extra.id), chief, extra)
        expect(item.record.state).toBe("queued")
      }
      expect(
        Exit.isFailure(yield* store.admit(request("dlg_root_6", chief.id, extra.id), chief, extra).pipe(Effect.exit)),
      ).toBe(true)
      const away = yield* store.admit(
        request("dlg_dir", books.id, extra.id),
        { ...books, dir: "/a" },
        { ...extra, dir: "/b" },
      )
      expect(away.record.state).toBe("failed")
      expect(away.record.reason).toContain("cannot leave the sender's workspace")
      expect(
        (yield* inbox.page(books.id)).messages.some(
          (item) => item.body.includes("cannot leave") && item.body.includes("not a completed worker reply"),
        ),
      ).toBe(true)
      const missing = yield* store.admit(request("dlg_gone", books.id, extra.id), books, extra, true)
      expect(missing.record.state).toBe("failed")
      expect(missing.record.reason).toContain("no longer available")
      expect(
        (yield* inbox.page(books.id)).messages.some(
          (item) => item.body.includes("no longer available") && item.body.includes("not a completed worker reply"),
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

test("completion and cancellation cannot overwrite each other's terminal result", async () => {
  await using directory = await tmpdir()
  const filename = path.join(directory.path, "delegation.sqlite")
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const first = RayaTaskDelegation.make(
          Context.get(yield* Layer.build(Database.layerFromPath(filename)), Database.Service),
        )
        const second = RayaTaskDelegation.make(
          Context.get(yield* Layer.build(Database.layerFromPath(filename)), Database.Service),
        )
        const chief = agent("chief", "generalist")
        const books = agent("books", "accountant")
        for (const index of Array.from({ length: 32 }, (_, index) => index)) {
          const admitted = yield* first.admit(request(`dlg_terminal_${index}`, chief.id, books.id), chief, books)
          const taken = (yield* first.take(books.id))!
          expect(taken.id).toBe(admitted.record.id)
          const exits = yield* Effect.all(
            [
              first.finish(taken.id, "completed", books, "Finished before cancellation.").pipe(Effect.exit),
              second.stop(taken.id, books, "Stopped by the user.").pipe(Effect.exit),
            ],
            { concurrency: "unbounded" },
          )
          const saved = yield* first.get(taken.id)
          const states = exits.flatMap((exit) => (Exit.isSuccess(exit) ? [exit.value.state] : []))
          expect(states.length).toBeGreaterThan(0)
          expect(states.every((state) => state === saved.state)).toBe(true)
          expect(saved.state === "completed" || saved.state === "cancelled").toBe(true)
          expect(saved.response).toBe(saved.state === "completed" ? "Finished before cancellation." : undefined)
          expect(saved.reason).toBe(saved.state === "cancelled" ? "Stopped by the user." : undefined)
        }
      }),
    ),
  )
})

test("an exact terminal replay restores a reply after publication failed", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = RayaTaskDelegation.make(database)
      const inbox = RayaTaskInbox.make(database)
      const chief = agent("chief", "generalist")
      const books = agent("books", "accountant")
      const admitted = yield* store.admit(request("dlg_reply_recovery", chief.id, books.id), chief, books)
      const taken = (yield* store.take(books.id))!
      expect(taken.id).toBe(admitted.record.id)
      yield* database.db.run(`
        CREATE TRIGGER fail_delegation_reply
        BEFORE INSERT ON raya_routine_message
        WHEN NEW.source LIKE 'reply:%'
        BEGIN
          SELECT RAISE(ABORT, 'injected reply failure');
        END
      `)
      expect(
        Exit.isFailure(
          yield* store
            .finish(taken.id, "completed", books, "Recovered accounting result.")
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect((yield* store.get(taken.id)).state).toBe("completed")
      expect((yield* inbox.page(chief.id)).messages.filter((item) => item.source.startsWith("reply:"))).toEqual([])
      yield* database.db.run("DROP TRIGGER fail_delegation_reply")

      expect((yield* store.finish(taken.id, "completed", books, "Recovered accounting result.")).state).toBe(
        "completed",
      )
      expect((yield* store.finish(taken.id, "completed", books, "Recovered accounting result.")).state).toBe(
        "completed",
      )
      const replies = (yield* inbox.page(chief.id)).messages.filter((item) => item.source.startsWith("reply:"))
      expect(replies).toHaveLength(1)
      expect(replies[0]?.body).toContain("Recovered accounting result.")
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("an exact attachment replay restores a start card after publication failed", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = RayaTaskDelegation.make(database)
      const inbox = RayaTaskInbox.make(database)
      const chief = agent("chief", "generalist")
      const books = agent("books", "accountant")
      const admitted = yield* store.admit(request("dlg_start_recovery", chief.id, books.id), chief, books)
      const taken = (yield* store.take(books.id))!
      expect(taken.id).toBe(admitted.record.id)
      yield* database.db.run(`
        CREATE TRIGGER fail_delegation_start
        BEFORE INSERT ON raya_routine_message
        WHEN NEW.source LIKE 'start:%'
        BEGIN
          SELECT RAISE(ABORT, 'injected start-card failure');
        END
      `)
      const sid = SessionID.make("ses_start_recovery")
      expect(Exit.isFailure(yield* store.attach(taken.id, "run-start-recovery", sid).pipe(Effect.exit))).toBe(true)
      expect(yield* store.get(taken.id)).toMatchObject({
        state: "running",
        childRunID: "run-start-recovery",
        sessionID: sid,
      })
      expect((yield* inbox.page(chief.id)).messages.filter((item) => item.source.startsWith("start:"))).toEqual([])
      yield* database.db.run("DROP TRIGGER fail_delegation_start")

      expect((yield* store.attach(taken.id, "run-start-recovery", sid)).state).toBe("running")
      expect((yield* store.attach(taken.id, "run-start-recovery", sid)).state).toBe("running")
      const starts = (yield* inbox.page(chief.id)).messages.filter((item) => item.source.startsWith("start:"))
      expect(starts).toHaveLength(1)
      expect(starts[0]?.body).toContain("no longer only queued")
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
      const done = yield* store.finish(
        first.record.id,
        "failed",
        books,
        undefined,
        undefined,
        "This request timed out. It was not completed.",
      )
      expect(done.state).toBe("failed")
      expect(done.reason).toContain("timed out")
      expect((yield* inbox.page(chief.id)).messages.some((item) => item.body.includes("timed out"))).toBe(true)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})
