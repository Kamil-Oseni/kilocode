import { describe, expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import type { BackgroundJob } from "@/background/job"
import type { MessageV2 } from "@/session/message-v2"
import { ChiefBranches } from "@/kilocode/chief/branches"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Storage.node, FSUtil.node, CrossSpawnSpawner.node, Git.node])))

const plan = [
  {
    id: "audit",
    name: "Safety audit",
    specialist: "researcher",
    access: "read" as const,
    brief: { objective: "Audit safety", constraints: ["Do not edit"], expectedReturn: "Findings" },
  },
  {
    id: "design",
    name: "UX audit",
    specialist: "designer",
    access: "read" as const,
    brief: { objective: "Audit UX", constraints: ["Do not edit"], expectedReturn: "Findings" },
  },
]

const cleanup = (storage: Storage.Interface, id: SessionID) =>
  Effect.addFinalizer(() =>
    Effect.all([storage.remove(["raya", "goal", id]), storage.remove(["raya", "chief", "branches", id])]).pipe(
      Effect.ignore,
    ),
  )

describe("Auto Chief branch ledger", () => {
  it.live("persists exact independent branches and refuses duplicate or widened admission", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const id = SessionID.make(`ses_chief_${crypto.randomUUID()}`)
      const createdAt = Date.now()
      yield* storage.replace(["raya", "goal", id], { createdAt, status: "active" })
      yield* cleanup(storage, id)
      const first = ChiefBranches.make(storage)
      const saved = yield* first.start({ goalID: id, goalCreatedAt: createdAt, requestID: "route-1", branches: plan })
      expect(saved.version).toBe(1)
      expect(saved.branches.map((item) => item.brief.objective)).toEqual(["Audit safety", "Audit UX"])
      const restarted = ChiefBranches.make(storage)
      expect((yield* restarted.read(id))?.requestID).toBe("route-1")
      expect(
        (yield* restarted.start({ goalID: id, goalCreatedAt: createdAt, requestID: "route-1", branches: plan }))
          .createdAt,
      ).toBe(saved.createdAt)
      expect(
        Exit.isFailure(
          yield* restarted
            .start({ goalID: id, goalCreatedAt: createdAt, requestID: "route-2", branches: plan })
            .pipe(Effect.exit),
        ),
      ).toBe(true)

      const child = SessionID.make(`ses_child_${crypto.randomUUID()}`)
      const input = {
        goalID: id,
        goalCreatedAt: createdAt,
        branchID: "audit",
        callID: "task-1",
        sessionID: child,
        access: "read" as const,
      }
      expect((yield* restarted.admit(input)).state).toBe("admitted")
      expect((yield* restarted.admit(input)).callID).toBe("task-1")
      const widened = yield* restarted.admit({ ...input, access: "edit" }).pipe(Effect.exit)
      expect(Exit.isFailure(widened)).toBe(true)
      const duplicate = yield* restarted.admit({ ...input, branchID: "design" }).pipe(Effect.exit)
      expect(Exit.isFailure(duplicate)).toBe(true)

      yield* storage.replace(["raya", "goal", id], { createdAt, status: "paused" })
      expect(
        Exit.isFailure(yield* restarted.admit({ ...input, branchID: "design", callID: "task-2" }).pipe(Effect.exit)),
      ).toBe(true)
    }),
  )

  it.live("blocks completion until every branch has a verified receipt and no background job is running", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const id = SessionID.make(`ses_chief_${crypto.randomUUID()}`)
      const createdAt = Date.now()
      yield* storage.replace(["raya", "goal", id], { createdAt, status: "active" })
      yield* cleanup(storage, id)
      const children = plan.map(() => SessionID.make(`ses_child_${crypto.randomUUID()}`))
      const rows = new Map<string, MessageV2.WithParts[]>()
      const sessions = {
        messages: ({ sessionID }: { sessionID: SessionID }) => Effect.succeed(rows.get(sessionID) ?? []),
      } as Pick<Session.Interface, "messages">
      let jobs: { id: string; status: string }[] = []
      const background = { list: () => Effect.succeed(jobs) } as unknown as Pick<BackgroundJob.Interface, "list">
      const ledger = ChiefBranches.make(storage, sessions, background)
      yield* ledger.start({ goalID: id, goalCreatedAt: createdAt, requestID: "route-1", branches: plan })
      for (const [index, item] of plan.entries()) {
        const child = children[index]
        yield* ledger.admit({
          goalID: id,
          goalCreatedAt: createdAt,
          branchID: item.id,
          callID: `task-${index}`,
          sessionID: child,
          access: "read",
        })
        const ref = { callID: `read-${index}`, messageID: `msg-${index}`, partID: `part-${index}` }
        rows.set(child, [
          {
            info: { id: ref.messageID, role: "assistant", time: { created: 1, completed: 2 } },
            parts: [{ type: "tool", id: ref.partID, callID: ref.callID, tool: "read", state: { status: "completed" } }],
          },
        ] as unknown as MessageV2.WithParts[])
        yield* ledger.settle({
          goalID: id,
          goalCreatedAt: createdAt,
          branchID: item.id,
          callID: `task-${index}`,
          sessionID: child,
          state: "completed",
          result: "Findings returned",
        })
        const parent = rows.get(id) ?? []
        parent.push({
          info: { id: `parent-${index}`, role: "assistant" },
          parts: [
            {
              type: "tool",
              tool: "task",
              callID: `task-${index}`,
              state: {
                status: "completed",
                metadata: { parentSessionId: id, sessionId: child, background: index === 0 },
              },
            },
          ],
        } as unknown as MessageV2.WithParts)
        rows.set(id, parent)
        if (index === 1)
          expect(
            Exit.isFailure(
              yield* ledger
                .review({
                  goalID: id,
                  goalCreatedAt: createdAt,
                  branchID: item.id,
                  callID: `task-${index}`,
                  sessionID: child,
                  evidence: ref,
                })
                .pipe(Effect.exit),
            ),
          ).toBe(true)
        rows.get(child)?.push({
          info: { id: `final-${index}`, role: "assistant", time: { created: 3, completed: 4 } },
          parts: [{ type: "text", text: "Findings returned" }],
        } as unknown as MessageV2.WithParts)
        if (index === 0) continue
        yield* ledger.review({
          goalID: id,
          goalCreatedAt: createdAt,
          branchID: item.id,
          callID: `task-${index}`,
          sessionID: child,
          evidence: ref,
        })
      }
      const unreviewed = yield* ledger.completion(id, createdAt).pipe(Effect.exit)
      expect(Exit.isFailure(unreviewed)).toBe(true)
      if (Exit.isFailure(unreviewed)) expect(Cause.pretty(unreviewed.cause)).toContain("unreviewed")
      yield* storage.replace(["raya", "goal", id], { createdAt, status: "paused" })
      expect(
        Exit.isFailure(
          yield* ledger
            .review({
              goalID: id,
              goalCreatedAt: createdAt,
              branchID: "audit",
              callID: "task-0",
              sessionID: children[0],
              evidence: { callID: "read-0", messageID: "msg-0", partID: "part-0" },
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      yield* storage.replace(["raya", "goal", id], { createdAt, status: "active" })
      yield* ledger.review({
        goalID: id,
        goalCreatedAt: createdAt,
        branchID: "audit",
        callID: "task-0",
        sessionID: children[0],
        evidence: { callID: "read-0", messageID: "msg-0", partID: "part-0" },
      })
      expect(Exit.isFailure(yield* ledger.completion(id, createdAt).pipe(Effect.exit))).toBe(true)
      const summary = {
        goalID: id,
        goalCreatedAt: createdAt,
        summary: "Safety and UX findings are both ready for the owner.",
        findings: [
          { branchID: "audit", conclusion: "Safety evidence was inspected." },
          { branchID: "design", conclusion: "UX evidence was inspected." },
        ],
      }
      expect(
        Exit.isFailure(yield* ledger.synthesize({ ...summary, findings: [summary.findings[0]] }).pipe(Effect.exit)),
      ).toBe(true)
      const synthesis = yield* ledger.synthesize(summary)
      expect(synthesis.findings.map((item) => item.branchID)).toEqual(["audit", "design"])
      expect(yield* ledger.synthesize(summary)).toEqual(synthesis)
      yield* storage.replace(["raya", "goal", id], { createdAt, status: "paused" })
      expect(Exit.isFailure(yield* ledger.synthesize(summary).pipe(Effect.exit))).toBe(true)
      yield* storage.replace(["raya", "goal", id], { createdAt, status: "active" })
      expect(
        Exit.isFailure(yield* ledger.synthesize({ ...summary, summary: "A changed summary" }).pipe(Effect.exit)),
      ).toBe(true)
      jobs = [{ id: children[0], status: "running" }]
      expect(Exit.isFailure(yield* ledger.completion(id, createdAt).pipe(Effect.exit))).toBe(true)
      jobs = [{ id: children[0], status: "error" }]
      expect(Exit.isFailure(yield* ledger.completion(id, createdAt).pipe(Effect.exit))).toBe(true)
      jobs = []
      yield* ChiefBranches.make(storage, sessions, background).completion(id, createdAt)
      const parent = rows.get(id)!
      rows.delete(id)
      expect(Exit.isFailure(yield* ledger.completion(id, createdAt).pipe(Effect.exit))).toBe(true)
      rows.set(id, parent)
      rows.delete(children[1])
      expect(Exit.isFailure(yield* ledger.completion(id, createdAt).pipe(Effect.exit))).toBe(true)
    }),
  )

  for (const state of ["failed", "cancelled", "unknown"] as const) {
    it.live(`refuses a ${state} child result even after a restart`, () =>
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const id = SessionID.make(`ses_chief_${crypto.randomUUID()}`)
        const child = SessionID.make(`ses_child_${crypto.randomUUID()}`)
        const createdAt = Date.now()
        yield* storage.replace(["raya", "goal", id], { createdAt, status: "active" })
        yield* cleanup(storage, id)
        const ledger = ChiefBranches.make(storage)
        yield* ledger.start({ goalID: id, goalCreatedAt: createdAt, requestID: "route-1", branches: plan })
        yield* ledger.admit({
          goalID: id,
          goalCreatedAt: createdAt,
          branchID: "audit",
          callID: "task-1",
          sessionID: child,
          access: "read",
        })
        yield* ledger.settle({
          goalID: id,
          goalCreatedAt: createdAt,
          branchID: "audit",
          callID: "task-1",
          sessionID: child,
          state,
          result: state,
        })
        const restarted = ChiefBranches.make(storage)
        expect((yield* restarted.read(id))?.branches[0].state).toBe(state)
        expect(Exit.isFailure(yield* restarted.completion(id, createdAt).pipe(Effect.exit))).toBe(true)
        expect(
          Exit.isFailure(
            yield* restarted
              .settle({
                goalID: id,
                goalCreatedAt: createdAt,
                branchID: "audit",
                callID: "task-1",
                sessionID: child,
                state: "completed",
                result: "late reply",
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    )
  }
})
