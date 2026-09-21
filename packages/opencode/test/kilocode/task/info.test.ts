import { expect, test } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import {
  RayaRoutineDelegationTable as Delegation,
  RayaRoutineOrganizationCoordinatorTable as Coordinator,
  RayaRoutineOrganizationReservationTable as Reservation,
  RayaRoutineOrganizationTable as Organization,
} from "@opencode-ai/core/kilocode/routine.sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { MessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Effect, Exit } from "effect"
import type { RayaTask } from "@/kilocode/task"
import { RayaTaskDelegation } from "@/kilocode/task/delegation"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { RayaTaskInfo, type Identity } from "@/kilocode/task/info"
import { MessageID, SessionID } from "@/session/schema"

const agent = (id: string, name: string, role: string): RayaTask.Agent => ({
  id,
  name,
  role,
  objective: `${name} standing work`,
  capabilities: role === "accountant" ? ["accounting"] : [],
  memoryScope: "project",
  schedule: { kind: "manual" },
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  access: "full",
})

test("routine chat info pages only persisted files and http links with message provenance", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const inbox = RayaTaskInbox.make(database)
      const info = RayaTaskInfo.make(database)
      const message = yield* inbox.publish({
        agentID: "books",
        source: "report:friday",
        kind: "report",
        body: "Review https://example.com/close, then http://reports.test/q3. Ignore ftp://private.test.",
        occurrenceID: "run_friday",
        sessionID: SessionID.make("ses_friday"),
        files: [
          { name: "ledger.pdf", path: "reports/ledger.pdf" },
          { name: "receipts.csv", path: "reports/receipts.csv" },
        ],
      })
      const first = yield* info.shares("books", undefined, 2)
      expect(first.section).toBe("shares")
      expect(first.items.map((item) => item.kind)).toEqual(["file", "file"])
      expect(first.items.every((item) => item.messageID === message.id && item.source === "report:friday")).toBe(true)
      expect(first.items.every((item) => item.occurrenceID === "run_friday" && item.sessionID === "ses_friday")).toBe(
        true,
      )
      expect(first.next).toBeDefined()
      const second = yield* info.shares("books", first.next, 2)
      expect(second.items.map((item) => (item.kind === "link" ? item.url : undefined))).toEqual([
        "https://example.com/close",
        "http://reports.test/q3",
      ])
      expect(second.items.map((item) => item.label)).toEqual(["example.com", "reports.test"])
      expect(second.next).toBeUndefined()
      expect(Exit.isFailure(yield* info.shares("books", "wrong-section", 2).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* info.shares("books", undefined, 51).pipe(Effect.exit))).toBe(true)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("routine chat info includes user attachment metadata without stored content", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const inbox = RayaTaskInbox.make(database)
      const info = RayaTaskInfo.make(database)
      const data = Buffer.from("private ledger").toString("base64")
      const message = yield* inbox.publish({
        agentID: "books",
        source: "user_attachment",
        kind: "user",
        body: "Review this ledger",
        sessionID: SessionID.make("ses_attachment"),
        attachments: [
          {
            id: "2564b7ed-998b-411d-aa41-e4414bb51111",
            name: "ledger.csv",
            mime: "text/csv",
            size: 14,
            data,
          },
        ],
      })
      const page = yield* info.shares("books")
      expect(page.items).toEqual([
        {
          kind: "attachment",
          attachmentID: "2564b7ed-998b-411d-aa41-e4414bb51111",
          label: "ledger.csv",
          mime: "text/csv",
          size: 14,
          messageID: message.id,
          messageKind: "user",
          source: "user_attachment",
          sessionID: SessionID.make("ses_attachment"),
          time: message.time,
        },
      ])
      expect(page.items[0]?.sessionID).toBe(SessionID.make("ses_attachment"))
      expect(JSON.stringify(page)).not.toContain(data)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("routine chat info continues bounded sparse share scans", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const inbox = RayaTaskInbox.make(database)
      const info = RayaTaskInfo.make(database)
      yield* inbox.publish({
        agentID: "books",
        source: "old_file",
        kind: "report",
        body: "Old report",
        files: [{ name: "old.pdf", path: "reports/old.pdf" }],
      })
      for (const n of Array.from({ length: 501 }, (_, index) => index))
        yield* inbox.publish({ agentID: "books", source: `plain_${n}`, kind: "worker", body: `Plain note ${n}` })
      const first = yield* info.shares("books")
      expect(first.items).toEqual([])
      expect(first.next).toBeDefined()
      const second = yield* info.shares("books", first.next)
      expect(second.items).toHaveLength(1)
      expect(second.items[0]).toMatchObject({ kind: "file", label: "old.pdf", path: "reports/old.pdf" })
      expect(second.next).toBeUndefined()
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("routine chat info pages durable sent and received delegation exchanges", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = RayaTaskDelegation.make(database)
      const info = RayaTaskInfo.make(database)
      const chief = agent("chief", "Chief of Staff", "generalist")
      const books = agent("books", "Accounting", "accountant")
      const legal = agent("legal", "Legal", "reviewer")
      const artifact = {
        path: "/reports/friday-close.csv",
        sha256: "c".repeat(64),
        tool: "write",
        callID: "call_friday_close",
      }
      const first = yield* store.admit(
        {
          source: "dlg_books",
          senderID: chief.id,
          recipientID: books.id,
          objective: "Reconcile Friday receipts.",
          expected: "List every missing receipt.",
          context: "The Friday close is due today.",
          parentRunID: "run_close",
          budget: 1000,
          artifacts: [artifact],
        },
        chief,
        books,
      )
      const taken = yield* store.take(books.id)
      const runID = taken!.childRunID!
      yield* store.attach(taken!.id, runID, SessionID.make("ses_books"))
      yield* store.finish(first.record.id, "completed", books, "Three receipts are missing.", 1.25)
      yield* store.admit(
        { source: "dlg_legal", senderID: legal.id, recipientID: chief.id, objective: "Confirm the expense policy." },
        legal,
        chief,
      )
      const identities = new Map<string, Identity>([
        [books.id, { name: books.name, role: books.role, archived: true }],
        [legal.id, { name: legal.name, role: legal.role, archived: false }],
      ])
      const resolve = (id: string) => Effect.succeed(identities.get(id)!)
      const firstPage = yield* info.contacts(chief.id, resolve, undefined, 1)
      expect(firstPage.section).toBe("contacts")
      expect(firstPage.items).toHaveLength(1)
      expect(firstPage.next).toBeDefined()
      const secondPage = yield* info.contacts(chief.id, resolve, firstPage.next, 1)
      const items = [...firstPage.items, ...secondPage.items]
      expect(items.map((item) => item.direction).sort()).toEqual(["received", "sent"])
      expect(items.find((item) => item.peerID === books.id)).toMatchObject({
        name: "Accounting",
        role: "accountant",
        archived: true,
        direction: "sent",
        source: "dlg_books",
        state: "completed",
        expected: "List every missing receipt.",
        context: "The Friday close is due today.",
        parentRunID: "run_close",
        budget: 1000,
        response: "Three receipts are missing.",
        cost: 1.25,
        occurrenceID: runID,
        sessionID: "ses_books",
        artifacts: [artifact],
      })
      expect(items.find((item) => item.peerID === legal.id)).toMatchObject({
        name: "Legal",
        archived: false,
        direction: "received",
        source: "dlg_legal",
        state: "queued",
      })
      expect(secondPage.next).toBeUndefined()
      expect(Exit.isFailure(yield* info.contacts(chief.id, resolve, firstPage.next, 0).pipe(Effect.exit))).toBe(true)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("organization activity reports authoritative branch spend across pages without double counting descendants", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const info = RayaTaskInfo.make(database)
      const organizationID = "org_11111111111111111111111111111111"
      yield* database.db.insert(Organization).values({
        id: organizationID,
        name: "Website Builders",
        purpose: null,
        policy: null,
        budget: 100,
        revision: 1,
        archived_at: null,
        time_created: 1,
        time_updated: 1,
      })
      const base = {
        sender_id: "chief",
        recipient_id: "worker",
        organization_id: organizationID,
        organization_name: "Website Builders",
        organization_revision: 1,
        workspace: null,
        expected: null,
        context: null,
        deadline: null,
        child_run_id: null,
        artifacts: null,
        response: null,
        reason: null,
      }
      yield* database.db.insert(Delegation).values([
        {
          ...base,
          id: "root_finished",
          source: "summary_root_finished",
          parent_id: null,
          parent_run_id: "run_one",
          objective: "Prepare the close.",
          budget: 20,
          depth: 1,
          state: "completed",
          session_id: "ses_root_finished",
          artifacts: JSON.stringify([
            {
              path: "/reports/close.csv",
              sha256: "d".repeat(64),
              tool: "write",
              callID: "call_close",
            },
          ]),
          cost: 2,
          time_created: 60,
          time_updated: 60,
        },
        {
          ...base,
          id: "child_live",
          source: "summary_child_live",
          parent_id: "root_finished",
          parent_run_id: "run_child_live",
          objective: "Resolve an exception.",
          budget: 5,
          depth: 2,
          state: "needs_input",
          session_id: "ses_child_live",
          cost: null,
          time_created: 50,
          time_updated: 50,
        },
        {
          ...base,
          id: "root_live",
          source: "summary_root_live",
          parent_id: null,
          parent_run_id: "run_two",
          objective: "Review the campaign.",
          budget: 10,
          depth: 1,
          state: "running",
          session_id: "ses_root_live",
          cost: null,
          time_created: 40,
          time_updated: 40,
        },
        {
          ...base,
          id: "child_finished",
          source: "summary_child_finished",
          parent_id: "root_live",
          parent_run_id: "run_child_finished",
          objective: "Check the audience.",
          budget: 4,
          depth: 2,
          state: "completed",
          session_id: "ses_child_finished",
          cost: 3,
          time_created: 30,
          time_updated: 30,
        },
        {
          ...base,
          id: "root_uncertain",
          source: "summary_root_uncertain",
          parent_id: null,
          parent_run_id: "run_three",
          objective: "Recover an interrupted report.",
          budget: 7,
          depth: 1,
          state: "cancelled",
          session_id: "ses_root_uncertain",
          cost: null,
          time_created: 20,
          time_updated: 20,
        },
        {
          ...base,
          id: "root_rejected",
          source: "summary_root_rejected",
          parent_id: null,
          parent_run_id: "run_four",
          objective: "Rejected before startup.",
          budget: 20,
          depth: 1,
          state: "failed",
          session_id: null,
          cost: null,
          time_created: 10,
          time_updated: 10,
        },
      ])
      yield* database.db.insert(ProjectTable).values({
        id: ProjectV2.ID.make("project_company_cost"),
        worktree: AbsolutePath.make("/workspace"),
        sandboxes: [],
        time_created: 1,
        time_updated: 1,
      })
      const session = {
        project_id: ProjectV2.ID.make("project_company_cost"),
        slug: "company-cost",
        directory: "/workspace",
        title: "Company work",
        version: "1",
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        time_created: 1,
        time_updated: 1,
      }
      yield* database.db.insert(SessionTable).values([
        {
          ...session,
          id: SessionID.make("ses_company_direct"),
          cost: 1.5,
          metadata: {
            rayaRoutine: {
              version: 1,
              agentID: "chief",
              runID: "run_company_direct",
              scheduleVersion: 1,
              trigger: { kind: "manual" },
              organizationID,
              organizationRevision: 1,
            },
          },
        },
        {
          ...session,
          id: SessionID.make("ses_company_delegated"),
          cost: 9,
          metadata: {
            rayaRoutine: {
              version: 1,
              agentID: "worker",
              runID: "run_company_delegated",
              scheduleVersion: 1,
              trigger: { kind: "manual" },
              delegationID: "root_finished",
              organizationID,
              organizationRevision: 1,
            },
          },
        },
        {
          ...session,
          id: SessionID.make("ses_company_reserved"),
          cost: 0.5,
          metadata: {
            rayaRoutine: {
              version: 1,
              agentID: "worker",
              runID: "run_company_reserved",
              scheduleVersion: 1,
              trigger: { kind: "manual" },
              organizationID,
              organizationRevision: 1,
              budget: 4,
            },
          },
        },
        {
          ...session,
          id: SessionID.make("ses_company_coordinator"),
          cost: 0.75,
        },
      ])
      yield* database.db.insert(Reservation).values({
        run_id: "run_company_reserved",
        agent_id: "worker",
        organization_id: organizationID,
        organization_revision: 1,
        session_id: "ses_company_reserved",
        budget: 4,
        cost: null,
        state: "linked",
        time_created: 1,
        time_updated: 1,
      })
      yield* database.db.insert(MessageTable).values({
        id: MessageID.make("msg_company_coordinator"),
        session_id: SessionID.make("ses_company_coordinator"),
        time_created: 1,
        data: {
          role: "assistant",
          cost: 0.75,
          time: { created: 1, completed: 2 },
          parentID: "msg_parent",
          modelID: "test",
          providerID: "test",
          mode: "build",
          agent: "build",
          path: { cwd: "/workspace", root: "/workspace" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } as never,
      })
      yield* database.db.insert(Coordinator).values({
        message_id: "msg_company_coordinator",
        session_id: "ses_company_coordinator",
        organization_id: organizationID,
        organization_revision: 1,
        state: "attributed",
        time_created: 1,
        time_updated: 1,
      })
      const resolve = (id: string) => Effect.succeed({ name: id, role: "worker", archived: false })
      const first = yield* info.activity(organizationID, resolve, undefined, 1)
      const second = yield* info.activity(organizationID, resolve, first.next, 1)
      expect(first.items).toHaveLength(1)
      expect(first.items[0]?.artifacts).toEqual([
        {
          path: "/reports/close.csv",
          sha256: "d".repeat(64),
          tool: "write",
          callID: "call_close",
        },
      ])
      expect(first.next).toBeDefined()
      expect(first.summary).toEqual({
        total: 6,
        active: 2,
        needsAttention: 2,
        uncertain: 1,
        recordedCost: 7.25,
        committedCost: 30.25,
        standaloneCost: 1.5,
        coordinatorCost: 0.75,
      })
      expect(second.summary).toEqual(first.summary)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})
