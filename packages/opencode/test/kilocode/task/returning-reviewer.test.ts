import { expect, test } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { Permission } from "@/permission"
import { KiloSession } from "@/kilocode/session"
import { upcoming } from "@/kilocode/task/cron"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { RayaTaskSnapshot } from "@/kilocode/task/snapshot"

function memory() {
  const data = new Map<string, unknown>()
  return {
    create: (key: string[], value: unknown) =>
      Effect.sync(() => {
        const id = key.join("/")
        if (data.has(id)) return false
        data.set(id, value)
        return true
      }),
    replace: (key: string[], value: unknown) =>
      Effect.sync(() => {
        data.set(key.join("/"), value)
      }),
    read<T>(key: string[]) {
      return Effect.gen(function* () {
        const found = data.get(key.join("/"))
        if (found === undefined) return yield* new Storage.NotFoundError({ message: "missing" })
        return found as T
      })
    },
    write: (key: string[], value: unknown) =>
      Effect.sync(() => {
        data.set(key.join("/"), value)
      }),
    remove: (key: string[]) =>
      Effect.sync(() => {
        data.delete(key.join("/"))
      }),
    update<T>(key: string[], fn: (draft: T) => void) {
      return Effect.gen(function* () {
        const found = data.get(key.join("/")) as T
        fn(found)
        data.set(key.join("/"), found)
        return found
      })
    },
    list: (prefix: string[]) => {
      const start = prefix.join("/")
      return Effect.sync(() => [...data.keys()].filter((key) => key.startsWith(start)).map((key) => key.split("/")))
    },
  }
}

function session(id: string) {
  return {
    id: SessionID.make(id),
    slug: "ask",
    title: "Accounts",
    projectID: ProjectV2.ID.make("project"),
    directory: "/tmp",
    version: "test",
    time: { created: Date.now(), updated: Date.now() },
  }
}

test("returning reviewer inspects schema then single-worker and delegation journeys", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const db = database.db
      const tables = (
        yield* db.all<{ name: string }>(
          sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'raya_routine%' ORDER BY name`,
        )
      ).map((row) => row.name)
      expect(tables).toEqual([
        "raya_routine_archive",
        "raya_routine_archive_import",
        "raya_routine_conversation",
        "raya_routine_cursor",
        "raya_routine_delegation",
        "raya_routine_message",
        "raya_routine_occurrence",
      ])
      const migrated = (
        yield* db.all<{ id: string }>(
          sql`SELECT id FROM migration WHERE id LIKE '%kilocode-routine%' ORDER BY id`,
        )
      ).map((row) => row.id)
      expect(migrated).toEqual([
        "20260908092112_kilocode-routine-occurrence",
        "20260908124554_kilocode-routine-archive",
        "20260911033250_kilocode-routine-inbox",
        "20260911183445_kilocode-routine-delegation",
        "20260911194749_kilocode-routine-delegation-cost",
      ])
      expect(
        (yield* db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'raya_routine_message%'`)).map(
          (row) => row.name,
        ),
      ).toContain("raya_routine_message_source")
      expect(
        (yield* db.all<{ name: string }>(sql`PRAGMA foreign_key_list('raya_routine_message')`)).some(
          (row) => "table" in row && row.table === "raya_routine_conversation",
        ),
      ).toBe(true)

      const storage = memory()
      const opened: Array<{
        id: SessionID
        metadata?: { rayaRoutine?: { agentID: string; runID: string } }
        permission?: Permission.Ruleset
      }> = []
      const root = AbsolutePath.make(process.cwd())
      const project = ProjectV2.ID.make("project")
      yield* db
        .insert(ProjectTable)
        .values({
          id: project,
          worktree: root,
          vcs: "git",
          time_created: Date.now(),
          time_updated: Date.now(),
          sandboxes: [],
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const persist = (info: ReturnType<typeof session>, input?: { metadata?: unknown; permission?: Permission.Ruleset }) =>
        db
          .insert(SessionTable)
          .values({
            id: info.id,
            project_id: project,
            slug: info.slug,
            directory: process.cwd(),
            title: info.title,
            version: info.version,
            metadata: (input?.metadata as Record<string, unknown> | undefined) ?? null,
            permission: input?.permission,
            cost: 0,
            tokens_input: 0,
            tokens_output: 0,
            tokens_reasoning: 0,
            tokens_cache_read: 0,
            tokens_cache_write: 0,
            time_created: info.time.created,
            time_updated: info.time.updated,
          })
          .run()
          .pipe(Effect.orDie)
      yield* persist(session("ses_chat"))
      const runner = RayaTaskRunner.make({
        database,
        storage,
        sessions: {
          create: (input) =>
            Effect.gen(function* () {
              const info = session(`ses_work_${opened.length + 1}`)
              opened.push({ id: info.id, metadata: input?.metadata, permission: input?.permission })
              yield* persist(info, input)
              return info
            }),
          get: () => Effect.die("unused"),
          messages: () => Effect.succeed([]),
          children: () => Effect.succeed([]),
        },
      })
      const inbox = RayaTaskInbox.make(database)
      const snapshots = RayaTaskSnapshot.make({ storage })
      const zone = "America/New_York"
      const expr = "0 18 * * 5"
      const first = yield* upcoming(expr, Date.parse("2026-09-01T00:00:00Z"), zone)
      const second = yield* upcoming(expr, first + 1, zone)
      const books = yield* runner.tasks.create({
        name: "Accounting",
        role: "accountant",
        objective: "Reconcile Friday receipts and name anything missing.",
        capabilities: ["accounting"],
        access: "full",
        enabled: true,
        schedule: { kind: "cron", expr, tz: zone },
        output: {
          destination: "conversation",
          description: "Friday close summary",
          criteria: [
            {
              id: "receipts",
              description: "Named missing receipts",
              verification: "Inspect the Friday receipt list.",
            },
          ],
        },
      })
      const chief = yield* runner.tasks.create({
        name: "Chief of Staff",
        role: "generalist",
        objective: "Coordinate Friday close.",
        access: "brief",
        enabled: true,
        schedule: { kind: "manual" },
      })
      yield* storage.replace(
        ["raya", "agent"],
        [
          { ...books, createdAt: first - 86_400_000, scheduleUpdatedAt: first - 86_400_000 },
          { ...chief, createdAt: first - 86_400_000, scheduleUpdatedAt: first - 86_400_000 },
        ],
      )
      yield* runner.tick(first + 30_000)
      const started = yield* runner.tasks.runsFor(books.id)
      expect(started).toHaveLength(1)
      const run = started[0]!
      expect(opened[0]?.metadata?.rayaRoutine).toMatchObject({
        agentID: books.id,
        runID: run.id,
      })
      expect(Permission.evaluate("edit", "file", opened[0]!.permission ?? []).action).toBe("allow")
      const now = Date.now()
      yield* storage.write(["raya", "goal", run.sessionID], {
        objective: "Reconcile Friday receipts and name anything missing.",
        status: "complete",
        createdAt: now,
        updatedAt: now,
        usage: { turns: 1, continuations: 0, toolCalls: 1 },
        progress: [],
        criteria: [
          {
            id: "receipts",
            description: "Named missing receipts",
            verification: "Inspect the Friday receipt list.",
          },
        ],
        audit: {
          summary: "Travel receipts are missing for Friday close.",
          verifiedAt: now,
          requirements: [
            {
              criterionID: "receipts",
              requirement: "Named missing receipts",
              passed: true,
              evidence: [{ callID: "read", summary: "Travel folder has no Friday receipts." }],
            },
          ],
        },
      })
      yield* runner.settle(run.sessionID)
      expect(
        (yield* db.get<{ state: string; session_id: string | null }>(
          sql`SELECT state, session_id FROM raya_routine_occurrence WHERE session_id = ${run.sessionID}`,
        )),
      ).toMatchObject({ session_id: run.sessionID })
      const reported = yield* inbox.page(books.id)
      expect(reported.messages).toHaveLength(1)
      expect(reported.messages[0]?.kind).toBe("report")
      expect(reported.messages[0]?.occurrenceID).toBe(run.id)
      expect(reported.messages[0]?.sessionID).toBe(run.sessionID)
      const box = (yield* inbox.summaries([books], new Map()))[0]!
      expect(box.conversationID.startsWith("rcv_")).toBe(true)
      expect(box.conversationID).not.toBe(run.sessionID)
      const question = "Why did expenses increase on that Friday report?"
      const asked = yield* inbox.admit({ agentID: books.id, source: "user_review", kind: "user", body: question })
      expect(asked.created).toBe(true)
      const follow = yield* runner.ask(books.id, question)
      const saved = yield* snapshots.find(follow.id)
      expect(saved?.objective).toContain(question)
      expect(saved?.objective).toContain(`report:${run.id}`)
      expect(saved?.objective).toContain("Travel receipts are missing for Friday close.")
      expect((yield* runner.tasks.get(books.id)).schedule).toEqual({ kind: "cron", expr, tz: zone })
      yield* inbox.attach(books.id, "user_review", follow.sessionID)
      yield* storage.write(["raya", "goal", follow.sessionID], {
        objective: saved?.objective,
        status: "complete",
        createdAt: now + 1,
        updatedAt: now + 1,
        usage: { turns: 1, continuations: 0, toolCalls: 0 },
        progress: [],
        audit: {
          summary: "The Friday report named missing travel receipts. No extra amount was invented.",
          verifiedAt: now + 1,
          requirements: [],
        },
      })
      yield* runner.settle(follow.sessionID)

      const child = yield* runner.delegate({
        source: "dlg_review",
        senderID: chief.id,
        recipientID: books.id,
        objective: "List missing Friday receipts.",
        expected: "Named missing receipts, not a payment.",
      })
      expect(child.state).toBe("running")
      expect(Permission.evaluate("edit", "file", opened.at(-1)!.permission ?? []).action).toBe("deny")
      expect(opened.at(-1)?.metadata?.rayaRoutine?.agentID).toBe(books.id)
      const paused = yield* runner.tasks.create({
        name: "Quiet",
        role: "reviewer",
        objective: "Review later.",
        access: "brief",
        enabled: false,
        schedule: { kind: "manual" },
      })
      expect(
        (yield* runner.delegate({
          source: "dlg_pause",
          senderID: chief.id,
          recipientID: paused.id,
          objective: "Review the Friday close.",
        })).state,
      ).toBe("failed")
      yield* storage.write(["raya", "goal", child.sessionID!], {
        objective: "Reconcile receipts.",
        status: "complete",
        createdAt: now + 2,
        updatedAt: now + 2,
        usage: { turns: 1, continuations: 0, toolCalls: 1 },
        progress: [],
        audit: { summary: "Travel receipts are still missing.", verifiedAt: now + 2, requirements: [] },
      })
      yield* runner.settle(child.sessionID!)
      const cards = yield* inbox.page(chief.id)
      expect(cards.messages.some((item) => item.kind === "delegation" && item.body.includes("Travel receipts are still missing."))).toBe(
        true,
      )
      expect(cards.messages.some((item) => item.body.includes("paused") && item.body.includes("not a completed worker reply"))).toBe(
        true,
      )

      yield* runner.tick(second + 30_000)
      const later = (yield* runner.tasks.runsFor(books.id)).find(
        (item) => item.trigger?.kind === "timer" && item.trigger.scheduledAt === second,
      )
      yield* storage.write(["raya", "goal", later!.sessionID], {
        objective: "Reconcile Friday receipts and name anything missing.",
        status: "complete",
        createdAt: now + 3,
        updatedAt: now + 3,
        usage: { turns: 1, continuations: 0, toolCalls: 1 },
        progress: [],
        criteria: [
          {
            id: "receipts",
            description: "Named missing receipts",
            verification: "Inspect the Friday receipt list.",
          },
        ],
        audit: {
          summary: "The next Friday close found the travel receipts.",
          verifiedAt: now + 3,
          requirements: [
            {
              criterionID: "receipts",
              requirement: "Named missing receipts",
              passed: true,
              evidence: [{ callID: "read", summary: "Travel receipts arrived after the first close." }],
            },
          ],
        },
      })
      yield* runner.settle(later!.sessionID)
      const page = yield* inbox.page(books.id)
      expect(page.messages.at(-1)?.body).toContain("The next Friday close found the travel receipts.")
      expect((yield* inbox.summaries([books], new Map()))[0]?.conversationID).toBe(box.conversationID)

      const chat = KiloSession.owned("chat")
      const listed = (yield* db.select({ id: SessionTable.id }).from(SessionTable).where(chat)).map((row) => row.id)
      expect(listed).toContain(SessionID.make("ses_chat"))
      expect(listed).not.toContain(run.sessionID)
      expect(listed).not.toContain(follow.sessionID)
      expect(listed).not.toContain(later!.sessionID)
      const only = KiloSession.owned("routine")
      const work = (yield* db.select({ id: SessionTable.id }).from(SessionTable).where(only)).map((row) => row.id)
      expect(work).toContain(run.sessionID)
      expect(work).not.toContain(SessionID.make("ses_chat"))
      expect((yield* db.select({ id: SessionTable.id }).from(SessionTable).where(sql`${SessionTable.id} = ${run.sessionID}`))[0]?.id).toBe(
        run.sessionID,
      )
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})
