import { describe, expect } from "bun:test"
import { spawnSync } from "node:child_process"
import { Cause, Deferred, Effect, Exit, Scope } from "effect"
import { BackgroundJob as CoreBackgroundJob } from "@opencode-ai/core/background-job"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { MessageID, SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import type { BackgroundJob } from "@/background/job"
import type { MessageV2 } from "@/session/message-v2"
import { ChiefBranches } from "@/kilocode/chief/branches"
import { ChiefBranchOutcome } from "@/kilocode/chief/outcome"
import { owner, stopped } from "@/kilocode/task/owner"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Storage.node, FSUtil.node, CrossSpawnSpawner.node, Git.node])))

const plan = [
  {
    id: "audit",
    name: "Safety audit",
    specialist: "researcher",
    access: "read" as const,
    brief: { objective: "Audit safety", constraints: ["Do not edit"], expectedReturn: "Findings" },
    scope: ["authorization"],
    independence: "Can review saved policy without the UX audit.",
    authority: "Read access covers this audit.",
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
  it.live("reserves one durable edit worktree and refuses changed or uncertain identities", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const id = SessionID.make(`ses_chief_${crypto.randomUUID()}`)
      const createdAt = Date.now()
      yield* storage.replace(["raya", "goal", id], { createdAt, status: "active" })
      yield* cleanup(storage, id)
      const ledger = ChiefBranches.make(storage)
      yield* ledger.start({
        goalID: id,
        goalCreatedAt: createdAt,
        requestID: "route-edit",
        branches: [
          { ...plan[0], access: "edit" },
          { ...plan[1], access: "edit" },
        ],
      })
      const input = {
        goalID: id,
        goalCreatedAt: createdAt,
        branchID: "audit",
        callID: "call-edit",
        name: "chief-audit",
        directory: "C:\\worktrees\\chief-audit",
        branch: "opencode/chief-audit",
        baseCommit: "a".repeat(40),
      }
      const reserved = yield* ledger.reserveWorktree(input)
      expect(reserved.phase).toBe("reserved")
      expect(yield* ChiefBranches.make(storage).reserveWorktree(input)).toEqual(reserved)
      expect(
        Exit.isFailure(
          yield* ledger.reserveWorktree({ ...input, directory: "C:\\worktrees\\other" }).pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* ledger.reserveWorktree({ ...input, branchID: "design", callID: "call-design" }).pipe(Effect.exit),
        ),
      ).toBe(true)
      const ready = yield* ledger.readyWorktree(input)
      expect(ready.phase).toBe("ready")
      expect((yield* ledger.read(id))?.branches[0].worktree?.baseCommit).toBe(input.baseCommit)
      expect(Exit.isFailure(yield* ledger.uncertainWorktree(input).pipe(Effect.exit))).toBe(true)
      expect(
        Exit.isFailure(yield* ledger.readyWorktree({ ...input, directory: "C:\\worktrees\\other" }).pipe(Effect.exit)),
      ).toBe(true)
      const other = {
        ...input,
        branchID: "design",
        callID: "call-design",
        name: "chief-design",
        directory: "C:\\worktrees\\chief-design",
        branch: "opencode/chief-design",
      }
      yield* ledger.reserveWorktree(other)
      const probe = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
        encoding: "utf8",
      })
      expect(probe.status).toBe(0)
      const saved = yield* ledger.read(id)
      if (!saved) throw new Error("Expected the reserved worktree")
      yield* storage.replace(["raya", "chief", "branches", id], {
        ...saved,
        branches: saved.branches.map((item) =>
          item.id === "design" && item.worktree
            ? { ...item, worktree: { ...item.worktree, owner: { ...item.worktree.owner, pid: Number(probe.stdout) } } }
            : item,
        ),
      })
      expect((yield* ledger.reconcile(id, createdAt)).branches[1].worktree?.phase).toBe("unknown")
      expect((yield* ledger.uncertainWorktree(other)).phase).toBe("unknown")
      expect(Exit.isFailure(yield* ledger.readyWorktree(other).pipe(Effect.exit))).toBe(true)
    }),
  )

  it.live("settles an admitted branch when its job scope closes in a live backend", () =>
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
        messageID: MessageID.make("msg-child"),
        access: "read",
      })
      const scope = yield* Scope.make()
      const jobs = yield* CoreBackgroundJob.make.pipe(Scope.provide(scope))
      const started = yield* Deferred.make<void>()
      yield* jobs.start({
        id: child,
        type: "task",
        run: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onExit((exit) =>
            ChiefBranchOutcome.record({
              branches: ledger,
              goalID: id,
              goalCreatedAt: createdAt,
              branchID: "audit",
              callID: "task-1",
              sessionID: child,
              exit,
            }),
          ),
        ),
      })
      yield* Deferred.await(started)
      yield* Scope.close(scope, Exit.void)
      expect((yield* jobs.get(child))?.status).toBe("running")
      expect((yield* ledger.read(id))?.branches[0].state).toBe("cancelled")
      expect((yield* ledger.reconcile(id, createdAt)).branches[0].state).toBe("cancelled")
      expect(
        Exit.isFailure(
          yield* ledger
            .admit({
              goalID: id,
              goalCreatedAt: createdAt,
              branchID: "audit",
              callID: "task-retry",
              sessionID: child,
              messageID: MessageID.make("msg-retry"),
              access: "read",
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
    }),
  )

  it.live("replans a revised goal only before any Chief branch is admitted", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const id = SessionID.make(`ses_chief_${crypto.randomUUID()}`)
      const createdAt = Date.now()
      yield* storage.replace(["raya", "goal", id], { createdAt, status: "active" })
      yield* cleanup(storage, id)
      const ledger = ChiefBranches.make(storage)
      const first = yield* ledger.start({ goalID: id, goalCreatedAt: createdAt, requestID: "route-1", branches: plan })
      const revised = [{ ...plan[0], brief: { ...plan[0].brief, objective: "Audit revised safety" } }, plan[1]]
      yield* storage.replace(["raya", "goal", id], {
        createdAt,
        status: "active",
        revisions: [{ id: "revision-2" }],
      })
      const second = yield* ChiefBranches.make(storage).start({
        goalID: id,
        goalCreatedAt: createdAt,
        requestID: "route-2",
        branches: revised,
      })
      expect(second.version).toBe(2)
      expect(second.revision).toBe("revision-2")
      expect(second.requestID).toBe("route-2")
      expect(second.branches[0].brief.objective).toBe("Audit revised safety")
      expect(second.branches.every((item) => item.state === "planned")).toBe(true)
      expect(second.createdAt).toBeGreaterThanOrEqual(first.createdAt)
      expect(
        (yield* ledger.start({ goalID: id, goalCreatedAt: createdAt, requestID: "route-2", branches: revised }))
          .createdAt,
      ).toBe(second.createdAt)
      expect(
        Exit.isFailure(
          yield* ledger
            .start({ goalID: id, goalCreatedAt: createdAt, requestID: "route-3", branches: revised })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
    }),
  )

  it.live("reconciles only a proven stopped owner's admitted child as unknown without replay", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const id = SessionID.make(`ses_chief_${crypto.randomUUID()}`)
      const createdAt = Date.now()
      yield* storage.replace(["raya", "goal", id], { createdAt, status: "active" })
      yield* cleanup(storage, id)
      const ledger = ChiefBranches.make(storage)
      yield* ledger.start({ goalID: id, goalCreatedAt: createdAt, requestID: "route-1", branches: plan })
      const child = SessionID.make(`ses_child_${crypto.randomUUID()}`)
      const input = {
        goalID: id,
        goalCreatedAt: createdAt,
        branchID: "audit",
        callID: "task-1",
        sessionID: child,
        access: "read" as const,
      }
      const admitted = yield* ledger.admit(input)
      expect(admitted.owner).toMatchObject(owner())
      if (process.platform === "win32" || process.platform === "linux") {
        expect(admitted.owner?.birth).toBeTruthy()
        expect(stopped({ ...admitted.owner, birth: `${admitted.owner?.birth}-older` })).toBe(true)
      }
      expect((yield* ChiefBranches.make(storage).reconcile(id, createdAt)).branches[0].state).toBe("admitted")

      const legacy = yield* ledger.read(id)
      if (!legacy) throw new Error("Expected the admitted branch plan")
      yield* storage.replace(["raya", "chief", "branches", id], {
        ...legacy,
        branches: legacy.branches.map((item) => (item.id === "audit" ? { ...item, owner: undefined } : item)),
      })
      expect((yield* ledger.reconcile(id, createdAt)).branches[0].state).toBe("admitted")

      const probe = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
        encoding: "utf8",
      })
      expect(probe.status).toBe(0)
      const dead = { ...owner(), pid: Number(probe.stdout) }
      expect(stopped(dead)).toBe(true)
      const saved = yield* ledger.read(id)
      if (!saved) throw new Error("Expected the admitted branch plan")
      yield* storage.replace(["raya", "chief", "branches", id], {
        ...saved,
        branches: saved.branches.map((item) => (item.id === "audit" ? { ...item, owner: dead } : item)),
      })
      const recovered = yield* ChiefBranches.make(storage).reconcile(id, createdAt)
      expect(recovered.branches[0]).toMatchObject({
        state: "unknown",
        callID: "task-1",
        sessionID: child,
      })
      expect(recovered.branches[0].result).toContain("Do not replay automatically")
      expect(recovered.branches[1].state).toBe("planned")
      expect((yield* ledger.reconcile(id, createdAt)).branches[0]).toEqual(recovered.branches[0])
      expect(Exit.isFailure(yield* ledger.admit(input).pipe(Effect.exit))).toBe(true)
      expect(
        Exit.isFailure(
          yield* ledger
            .settle({ ...input, state: "completed", result: "Late success cannot replace unknown" })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
    }),
  )

  it.live("recovers only an exact terminal parent and child receipt from a stopped backend", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const id = SessionID.make(`ses_chief_${crypto.randomUUID()}`)
      const createdAt = Date.now()
      const children = plan.map(() => SessionID.make(`ses_child_${crypto.randomUUID()}`))
      yield* storage.replace(["raya", "goal", id], { createdAt, status: "active" })
      yield* cleanup(storage, id)
      const ledger = ChiefBranches.make(storage)
      yield* ledger.start({ goalID: id, goalCreatedAt: createdAt, requestID: "route-1", branches: plan })
      for (const [index, item] of plan.entries())
        yield* ledger.admit({
          goalID: id,
          goalCreatedAt: createdAt,
          branchID: item.id,
          callID: `call-${item.id}`,
          sessionID: children[index],
          access: item.access,
        })
      const probe = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
        encoding: "utf8",
      })
      expect(probe.status).toBe(0)
      const dead = { ...owner(), pid: Number(probe.stdout) }
      expect(stopped(dead)).toBe(true)
      const saved = yield* ledger.read(id)
      if (!saved) throw new Error("Expected the admitted branch plan")
      yield* storage.replace(["raya", "chief", "branches", id], {
        ...saved,
        branches: saved.branches.map((item) => ({ ...item, owner: dead })),
      })
      const receipt = (index: number) => ({
        type: "tool",
        tool: "task",
        callID: `call-${plan[index].id}`,
        state: {
          status: "completed",
          metadata: { parentSessionId: id, sessionId: children[index], childMessageID: `msg-child-${index}` },
        },
      })
      const parent = [
        { info: { role: "assistant" }, parts: [receipt(0), receipt(1), { ...receipt(1), state: { status: "error" } }] },
      ] as unknown as MessageV2.WithParts[]
      const rows = new Map<string, MessageV2.WithParts[]>([
        [id, parent],
        ...children.map(
          (child, index) =>
            [
              child,
              [
                { info: { role: "user", id: `msg-child-${index}` }, parts: [{ type: "text", text: "Run" }] },
                {
                  info: { role: "assistant", time: { completed: Date.now() } },
                  parts: [{ type: "text", text: "Verified result" }],
                },
              ] as unknown as MessageV2.WithParts[],
            ] as const,
        ),
      ])
      const sessions = {
        get: (sessionID: SessionID) => Effect.succeed({ parentID: id, id: sessionID } as Session.Info),
        messages: ({ sessionID }: { sessionID: SessionID }) => Effect.succeed(rows.get(sessionID) ?? []),
      } as Pick<Session.Interface, "get" | "messages">
      const restarted = ChiefBranches.make(storage, sessions)
      const recovered = yield* restarted.reconcile(id, createdAt)
      expect(recovered.branches.map((item) => item.state)).toEqual(["completed", "unknown"])
      expect(recovered.branches[0].result).toContain("Exact saved parent receipt")
      expect(recovered.branches[1].result).toContain("Do not replay automatically")
      expect((yield* restarted.reconcile(id, createdAt)).branches).toEqual(recovered.branches)
    }),
  )

  it.live("does not recover an earlier reply when the bound child turn later errors", () =>
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
        callID: "call-audit",
        sessionID: child,
        access: "read",
      })
      const saved = yield* ledger.read(id)
      if (!saved) throw new Error("Expected the admitted branch plan")
      yield* storage.replace(["raya", "chief", "branches", id], {
        ...saved,
        branches: saved.branches.map((item) =>
          item.id === "audit" ? { ...item, owner: { ...owner(), pid: 2_147_483_647 } } : item,
        ),
      })
      const rows = new Map<string, MessageV2.WithParts[]>([
        [
          id,
          [
            {
              info: { role: "assistant" },
              parts: [
                {
                  type: "tool",
                  tool: "task",
                  callID: "call-audit",
                  state: {
                    status: "completed",
                    metadata: { parentSessionId: id, sessionId: child, childMessageID: "msg-child" },
                  },
                },
              ],
            },
          ] as unknown as MessageV2.WithParts[],
        ],
        [
          child,
          [
            { info: { role: "user", id: "msg-child" }, parts: [] },
            { info: { role: "assistant", time: { completed: 1 } }, parts: [{ type: "text", text: "Partial" }] },
            {
              info: {
                role: "assistant",
                error: { name: "Error", data: { message: "Failed" } },
                time: { completed: 2 },
              },
              parts: [],
            },
          ] as unknown as MessageV2.WithParts[],
        ],
      ])
      const sessions = {
        get: () => Effect.succeed({ parentID: id } as Session.Info),
        messages: ({ sessionID }: { sessionID: SessionID }) => Effect.succeed(rows.get(sessionID) ?? []),
      } as Pick<Session.Interface, "get" | "messages">
      const recovered = yield* ChiefBranches.make(storage, sessions).reconcile(id, createdAt)
      expect(recovered.branches[0].state).toBe("unknown")
    }),
  )

  it.live("persists exact independent branches and refuses duplicate or widened admission", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const id = SessionID.make(`ses_chief_${crypto.randomUUID()}`)
      const createdAt = Date.now()
      yield* storage.replace(["raya", "goal", id], { createdAt, status: "active" })
      yield* cleanup(storage, id)
      const first = ChiefBranches.make(storage)
      const saved = yield* first.start({ goalID: id, goalCreatedAt: createdAt, requestID: "route-1", branches: plan })
      expect(saved.version).toBe(2)
      expect(saved.branches.map((item) => item.brief.objective)).toEqual(["Audit safety", "Audit UX"])
      const restarted = ChiefBranches.make(storage)
      expect((yield* restarted.read(id))?.requestID).toBe("route-1")
      expect((yield* restarted.read(id))?.branches[0]).toMatchObject({
        scope: ["authorization"],
        independence: "Can review saved policy without the UX audit.",
        authority: "Read access covers this audit.",
      })
      expect(
        (yield* restarted.start({ goalID: id, goalCreatedAt: createdAt, requestID: "route-1", branches: plan }))
          .createdAt,
      ).toBe(saved.createdAt)
      expect(
        Exit.isFailure(
          yield* restarted
            .start({
              goalID: id,
              goalCreatedAt: createdAt,
              requestID: "route-1",
              branches: [{ ...plan[0], authority: "Changed reason" }, plan[1]],
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
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

      yield* storage.replace(["raya", "goal", id], {
        createdAt,
        status: "active",
        revisions: [{ id: crypto.randomUUID() }],
      })
      expect(
        Exit.isFailure(yield* restarted.admit({ ...input, branchID: "design", callID: "task-2" }).pipe(Effect.exit)),
      ).toBe(true)
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
        const input = MessageID.make(`msg-input-${index}`)
        yield* ledger.admit({
          goalID: id,
          goalCreatedAt: createdAt,
          branchID: item.id,
          callID: `task-${index}`,
          sessionID: child,
          messageID: input,
          access: "read",
        })
        const ref = { callID: `read-${index}`, messageID: `msg-${index}`, partID: `part-${index}` }
        rows.set(child, [
          { info: { id: input, role: "user" }, parts: [{ type: "text", text: "Audit" }] },
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
        rows.get(child)?.push(
          {
            info: { id: "later-input", role: "user" },
            parts: [{ type: "text", text: "Unrelated task" }],
          } as MessageV2.WithParts,
          {
            info: { id: "later-tool", role: "assistant", time: { created: 5, completed: 6 } },
            parts: [
              { type: "tool", id: "later-part", callID: "later-call", tool: "read", state: { status: "completed" } },
            ],
          } as MessageV2.WithParts,
          {
            info: { id: "later-final", role: "assistant", time: { created: 7, completed: 8 } },
            parts: [{ type: "text", text: "Unrelated newer result" }],
          } as MessageV2.WithParts,
        )
        expect(
          Exit.isFailure(
            yield* ledger
              .review({
                goalID: id,
                goalCreatedAt: createdAt,
                branchID: item.id,
                callID: `task-${index}`,
                sessionID: child,
                evidence: { callID: "later-call", messageID: "later-tool", partID: "later-part" },
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
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
      yield* storage.replace(["raya", "goal", id], {
        createdAt,
        status: "active",
        dispatch: { messageID: "later-continuation" },
      })
      yield* ChiefBranches.make(storage, sessions, background).completion(id, createdAt)
      yield* storage.replace(["raya", "goal", id], {
        createdAt,
        status: "active",
        revisions: [{ id: crypto.randomUUID() }],
      })
      expect(Exit.isFailure(yield* ledger.completion(id, createdAt).pipe(Effect.exit))).toBe(true)
      yield* storage.replace(["raya", "goal", id], { createdAt, status: "active" })
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
