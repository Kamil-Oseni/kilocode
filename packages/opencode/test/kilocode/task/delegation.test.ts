import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@/session/schema"
import { RayaTaskDelegation, ceiling, replied, scope, type Request } from "@/kilocode/task/delegation"
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
})

test("delegation admits once, refuses loops, and queues without duplicating a busy worker", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = RayaTaskDelegation.make(yield* Database.Service)
      const chief = agent("chief", "generalist")
      const books = agent("books", "accountant")
      const first = yield* store.admit(request("dlg_1", chief.id, books.id), chief, books)
      expect(first.created).toBe(true)
      expect(first.record.state).toBe("queued")
      expect(first.record.depth).toBe(1)
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
