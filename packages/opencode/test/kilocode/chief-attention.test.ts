import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { ChiefBranches } from "@/kilocode/chief/branches"
import type { Session } from "@/session/session"
import type { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Storage.node, FSUtil.node, CrossSpawnSpawner.node, Git.node])))

describe("Chief note attention", () => {
  it.live("acks only notes in an exact saved inspection and leaves later notes pending", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const goalID = SessionID.make(`ses_chief_${crypto.randomUUID()}`)
      const childID = SessionID.make(`ses_child_${crypto.randomUUID()}`)
      const otherID = SessionID.make(`ses_child_${crypto.randomUUID()}`)
      const childMessageID = MessageID.make(`msg_${crypto.randomUUID()}`)
      const otherMessageID = MessageID.make(`msg_${crypto.randomUUID()}`)
      const requestID = `msg_${crypto.randomUUID()}`
      const goalCreatedAt = Date.now()
      const revision = "rev-1"
      const state = { createdAt: goalCreatedAt, status: "active", revisions: [{ id: revision }] }
      yield* storage.replace(["raya", "goal", goalID], state)
      yield* Effect.addFinalizer(() =>
        Effect.all([
          storage.remove(["raya", "goal", goalID]),
          storage.remove(["raya", "chief", "branches", goalID]),
        ]).pipe(Effect.ignore),
      )
      const rows: MessageV2.WithParts[] = []
      const sessions = { messages: () => Effect.succeed(rows) } as Pick<Session.Interface, "messages">
      const ledger = ChiefBranches.make(storage, sessions)
      yield* ledger.start({
        goalID,
        goalCreatedAt,
        requestID,
        branches: [
          {
            id: "audit",
            name: "Safety audit",
            specialist: "researcher",
            access: "read",
            brief: { objective: "Audit safety", constraints: [], expectedReturn: "Findings" },
          },
          {
            id: "design",
            name: "UX audit",
            specialist: "designer",
            access: "read",
            brief: { objective: "Audit UX", constraints: [], expectedReturn: "Findings" },
          },
        ],
      })
      yield* ledger.admit({
        goalID,
        goalCreatedAt,
        branchID: "audit",
        callID: "task-audit",
        sessionID: childID,
        messageID: childMessageID,
        access: "read",
      })
      yield* ledger.admit({
        goalID,
        goalCreatedAt,
        branchID: "design",
        callID: "task-design",
        sessionID: otherID,
        messageID: otherMessageID,
        access: "read",
      })
      const make = (branchID: string, call: string) => ({
        goalID,
        goalCreatedAt,
        requestID,
        branchID,
        taskCallID: branchID === "audit" ? "task-audit" : "task-design",
        childSessionID: branchID === "audit" ? childID : otherID,
        childMessageID: branchID === "audit" ? childMessageID : otherMessageID,
        senderMessageID: MessageID.make(`msg_${call}`),
        toolCallID: call,
        text: `Progress ${call}`,
      })
      const first = yield* ledger.note(make("audit", "one"))
      expect((yield* ledger.note(make("audit", "one"))).id).toBe(first.id)
      expect((yield* ledger.pending({ goalID, goalCreatedAt, requestID, revision })).map((note) => note.id)).toEqual([
        first.id,
      ])
      const part = {
        id: "part-inspect",
        type: "tool",
        tool: "chief_inspect",
        callID: "call-inspect",
        state: {
          status: "completed",
          input: {},
          output: JSON.stringify({
            requestID,
            branches: [
              { id: "audit", notes: [first] },
              { id: "design", notes: [] },
            ],
          }),
          metadata: { requestID, goalCreatedAt },
          title: "Auto Chief branch results",
          time: { start: goalCreatedAt, end: Date.now() + 1 },
        },
      }
      rows.push({
        info: { id: MessageID.make("msg_inspect"), role: "assistant" },
        parts: [part],
      } as unknown as MessageV2.WithParts)
      const second = yield* ledger.note(make("design", "two"))
      const later = yield* ledger.note(make("audit", "three"))
      const input = {
        goalID,
        goalCreatedAt,
        requestID,
        revision,
        inspect: { messageID: MessageID.make("msg_inspect"), partID: part.id, callID: part.callID },
        ids: [first.id],
      }
      part.state.output = JSON.stringify({
        requestID,
        branches: [
          { id: "audit", notes: [{ ...first, childSessionID: otherID }] },
          { id: "design", notes: [] },
        ],
      })
      expect(Exit.isFailure(yield* ledger.acknowledge(input).pipe(Effect.exit))).toBe(true)
      part.state.output = JSON.stringify({
        requestID,
        branches: [
          { id: "audit", notes: [] },
          { id: "design", notes: [first] },
        ],
      })
      expect(Exit.isFailure(yield* ledger.acknowledge(input).pipe(Effect.exit))).toBe(true)
      part.state.output = JSON.stringify({
        requestID,
        branches: [
          { id: "audit", notes: [first] },
          { id: "design", notes: [] },
        ],
      })
      expect(yield* ledger.acknowledge(input)).toEqual([first.id])
      expect(yield* ledger.acknowledge(input)).toEqual([])
      expect((yield* ledger.pending({ goalID, goalCreatedAt, requestID, revision })).map((note) => note.id)).toEqual([
        second.id,
        later.id,
      ])
      expect(Exit.isFailure(yield* ledger.acknowledge({ ...input, ids: [second.id] }).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* ledger.acknowledge({ ...input, ids: [later.id] }).pipe(Effect.exit))).toBe(true)
      expect(
        Exit.isFailure(yield* ledger.pending({ goalID, goalCreatedAt, requestID, revision: "old" }).pipe(Effect.exit)),
      ).toBe(true)
      expect(Exit.isFailure(yield* ledger.acknowledge({ ...input, revision: "old" }).pipe(Effect.exit))).toBe(true)
      state.status = "paused"
      yield* storage.replace(["raya", "goal", goalID], state)
      expect(
        Exit.isFailure(yield* ledger.pending({ goalID, goalCreatedAt, requestID, revision }).pipe(Effect.exit)),
      ).toBe(true)
      expect(Exit.isFailure(yield* ledger.acknowledge(input).pipe(Effect.exit))).toBe(true)
      state.status = "active"
      state.revisions.push({ id: "rev-2" })
      yield* storage.replace(["raya", "goal", goalID], state)
      expect(Exit.isFailure(yield* ledger.acknowledge(input).pipe(Effect.exit))).toBe(true)
    }),
  )

  it.live("does not treat legacy saved notes as new attention", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const goalID = SessionID.make(`ses_chief_${crypto.randomUUID()}`)
      const goalCreatedAt = Date.now()
      const requestID = `msg_${crypto.randomUUID()}`
      yield* storage.replace(["raya", "goal", goalID], {
        createdAt: goalCreatedAt,
        status: "active",
        revisions: [{ id: "rev-1" }],
      })
      yield* Effect.addFinalizer(() =>
        Effect.all([
          storage.remove(["raya", "goal", goalID]),
          storage.remove(["raya", "chief", "branches", goalID]),
        ]).pipe(Effect.ignore),
      )
      const ledger = ChiefBranches.make(storage)
      const plan = yield* ledger.start({
        goalID,
        goalCreatedAt,
        requestID,
        branches: [
          {
            id: "a",
            name: "A",
            specialist: "researcher",
            access: "read",
            brief: { objective: "A", constraints: [], expectedReturn: "A" },
          },
          {
            id: "b",
            name: "B",
            specialist: "designer",
            access: "read",
            brief: { objective: "B", constraints: [], expectedReturn: "B" },
          },
        ],
      })
      const note = {
        version: 1 as const,
        id: "msg_legacy:call_legacy",
        branchID: "a",
        requestID,
        goalCreatedAt,
        taskCallID: "task-a",
        childSessionID: SessionID.make("ses_child_legacy"),
        childMessageID: MessageID.make("msg_child_legacy"),
        senderMessageID: MessageID.make("msg_legacy"),
        toolCallID: "call_legacy",
        text: "Already delivered before the attention ledger",
        at: goalCreatedAt,
        state: "delivered" as const,
      }
      yield* storage.replace(["raya", "chief", "branches", goalID], { ...plan, notes: [note] })
      expect(yield* ledger.pending({ goalID, goalCreatedAt, requestID, revision: "rev-1" })).toEqual([])
      expect((yield* ledger.read(goalID))?.notes).toEqual([note])
    }),
  )
})
