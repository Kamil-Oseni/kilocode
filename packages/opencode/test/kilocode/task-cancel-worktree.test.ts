import path from "node:path"
import { expect } from "bun:test"
import { Deferred, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Git } from "@/git"
import { InstanceState } from "@/effect/instance-state"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import { Storage } from "@/storage/storage"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Worktree } from "@/worktree"
import { RayaGoal } from "@/kilocode/goal"
import { RayaChief } from "@/kilocode/chief"
import { ChiefBranches } from "@/kilocode/chief/branches"
import * as TaskWorker from "@/kilocode/session/task-worker"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

const model = ProviderTest.model()
const provider = ProviderTest.fake({ model })
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      Session.node,
      SessionRunState.node,
      TaskWorker.node,
      Provider.node,
      RuntimeFlags.node,
      Database.node,
      Config.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      Truncate.node,
      ToolRegistry.node,
      Permission.node,
      Question.node,
      Ripgrep.node,
      Storage.node,
      FSUtil.node,
      Git.node,
      Worktree.node,
    ]),
    [
      [Provider.node, provider.layer],
      [InstanceStore.bootstrapNode, InstanceBootstrap.node],
    ],
  ),
)

for (const method of ["revision", "session", "completed", "replaced"] as const)
  it.instance(
    `real planned Task worktree ${method} Stop joins cross-directory descendants and leaves unrelated work running`,
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const jobs = yield* BackgroundJob.Service
        const runs = yield* SessionRunState.Service
        const workers = yield* TaskWorker.Service
        const store = yield* InstanceStore.Service
        const storage = yield* Storage.Service
        const worktrees = yield* Worktree.Service
        const parent = yield* InstanceState.directory
        const git = yield* Git.Service
        yield* Effect.promise(() => Bun.write(path.join(parent, ".git", "info", "exclude"), ".raya-profile-locks/\n"))
        expect((yield* git.run(["add", "opencode.json"], { cwd: parent })).exitCode).toBe(0)
        expect((yield* git.run(["commit", "-m", "Private fixture configuration"], { cwd: parent })).exitCode).toBe(0)
        const root = yield* sessions.create({ title: "planned worktree parent" })
        yield* Effect.addFinalizer(() =>
          Effect.all([
            storage.remove(["raya", "goal", root.id]),
            storage.remove(["raya", "chief", "branches", root.id]),
          ]).pipe(Effect.asVoid, Effect.orDie),
        )
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: root.id,
          agent: "auto",
          model: { providerID: model.providerID, modelID: model.id },
          time: { created: Date.now() },
        })
        const reply = (session: SessionID, message: MessageID, directory: string): SessionV1.WithParts => ({
          info: {
            id: MessageID.ascending(),
            role: "assistant",
            sessionID: session,
            parentID: message,
            agent: "general",
            mode: "general",
            cost: 0,
            path: { cwd: directory, root: directory },
            modelID: model.id,
            providerID: model.providerID,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: Date.now() },
            finish: "stop",
          },
          parts: [],
        })
        const assistant = reply(root.id, user.id, parent)
        yield* sessions.updateMessage({ ...assistant.info, agent: "auto", mode: "auto" })
        const goals = RayaGoal.make({ storage, sessions })
        const goal = yield* goals.create(root.id, "Edit a child-only file", user.id)
        if (!goal.intent) throw new Error("Genuine goal intent required")
        yield* goals.initial(root.id, goal.intent, "auto")
        const ledger = ChiefBranches.make(storage)
        yield* ledger.start({
          goalID: root.id,
          goalCreatedAt: goal.createdAt,
          requestID: user.id,
          branches: [
            {
              id: "edit",
              name: "File editor",
              specialist: "general",
              access: "edit",
              brief: { objective: "Write a child-only file", constraints: [], expectedReturn: "Edited file" },
            },
            {
              id: "audit",
              name: "Independent audit",
              specialist: "researcher",
              access: "read",
              brief: { objective: "Review independent context", constraints: [], expectedReturn: "Audit" },
            },
          ],
        })
        yield* sessions.setMetadata({
          sessionID: root.id,
          metadata: { [RayaChief.requestKey]: "Edit a child-only file", [RayaChief.phaseKey]: "task" },
        })
        const other = yield* tmpdirScoped({ config: { formatter: false, lsp: false, mcp: {}, plugin: [] } })
        const entered = yield* Deferred.make<void>()
        const ended = yield* Deferred.make<void>()
        const foreign = yield* store.provide(
          { directory: other },
          jobs.start({
            type: "task",
            run: Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(ended, undefined)),
            ),
          }),
        )
        yield* Deferred.await(entered)
        if (!foreign.revision) throw new Error("Unrelated revision required")
        const observed = foreign.revision
        yield* Effect.addFinalizer(() =>
          store.provide({ directory: other }, jobs.cancelTree(foreign.id, observed)).pipe(Effect.asVoid),
        )
        const opened = yield* Deferred.make<SessionID>()
        const ready = yield* Deferred.make<SessionID, unknown>()
        const nested = yield* Deferred.make<void>()
        const stopped = yield* Deferred.make<void>()
        const settled = yield* Deferred.make<void>()
        const def = yield* (yield* TaskTool).init()
        const ops: TaskPromptOps = {
          cancel: (session, message) =>
            message
              ? workers.cancel(session, message).pipe(Effect.asVoid)
              : Effect.die(new Error("Exact child input required")),
          resolvePromptParts: (text) => Effect.succeed([{ type: "text", text }]),
          prompt: (input) =>
            Effect.gen(function* () {
              if (!input.messageID) throw new Error("Actual child input required")
              const message = input.messageID
              const directory = yield* InstanceState.directory
              const primary = yield* Deferred.await(opened)
              const result = reply(input.sessionID, input.messageID, directory)
              return yield* runs.ensureRunning(
                input.sessionID,
                Effect.succeed(result),
                Effect.gen(function* () {
                  expect(yield* workers.bind(input.sessionID, message)).toBe(true)
                  expect((yield* workers.current)?.messageID).toBe(input.messageID)
                  expect(directory).not.toBe(parent)
                  if (input.sessionID !== primary) {
                    return yield* Deferred.succeed(nested, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.ensuring(Deferred.succeed(stopped, undefined)),
                    )
                  }
                  yield* sessions.updateMessage(result.info)
                  const exit = yield* Effect.exit(
                    def.execute(
                      { prompt: "Perform authorized nested work", subagent_type: "general", background: true },
                      {
                        sessionID: input.sessionID,
                        messageID: result.info.id,
                        callID: "nested-call",
                        agent: "general",
                        abort: new AbortController().signal,
                        messages: [],
                        extra: { promptOps: ops },
                        metadata: () => Effect.void,
                        ask: () => Effect.void,
                      },
                    ),
                  )
                  if (Exit.isFailure(exit)) {
                    yield* Deferred.failCause(ready, exit.cause)
                    return yield* Effect.failCause(exit.cause)
                  }
                  return yield* Deferred.succeed(ready, exit.value.metadata.sessionId).pipe(
                    Effect.andThen(
                      method === "completed" || method === "replaced"
                        ? Deferred.await(nested).pipe(Effect.as(result))
                        : Effect.never,
                    ),
                    Effect.ensuring(Deferred.succeed(settled, undefined)),
                  )
                }).pipe(Effect.ensuring(workers.release)),
              )
            }),
        }
        expect(yield* git.status(parent)).toEqual([])
        const dispatch = def.execute(
          { description: "File editor", branch_id: "edit", background: true },
          {
            sessionID: root.id,
            messageID: assistant.info.id,
            callID: "edit-call",
            agent: "auto",
            abort: new AbortController().signal,
            messages: [],
            extra: { promptOps: ops },
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        const done = yield* Deferred.make<void>()
        const dispatched = yield* method === "revision"
          ? dispatch
          : Effect.gen(function* () {
              const admitted = yield* Deferred.make<Effect.Success<typeof dispatch>, unknown>()
              yield* Effect.addFinalizer(() => runs.cancel(root.id))
              yield* runs
                .ensureRunning(
                  root.id,
                  Effect.succeed(assistant),
                  dispatch.pipe(
                    Effect.catchCause((cause) =>
                      Deferred.failCause(admitted, cause).pipe(Effect.andThen(Effect.failCause(cause))),
                    ),
                    Effect.flatMap((value) => Deferred.succeed(admitted, value).pipe(Effect.andThen(Effect.never))),
                    Effect.ensuring(Deferred.succeed(done, undefined)),
                  ),
                )
                .pipe(Effect.forkChild)
              return yield* Deferred.await(admitted)
            })
        const child = dispatched.metadata.sessionId
        const selected = yield* jobs.get(child)
        if (!selected?.revision) throw new Error("Root execution revision required")
        const revision = selected.revision
        const saved = (yield* ledger.read(root.id))?.branches[0].worktree
        if (!saved?.directory) throw new Error("Actual reserved edit worktree required")
        const directory = saved.directory
        expect((yield* sessions.get(child)).directory).toBe(directory)
        expect(directory).not.toBe(parent)
        yield* Effect.addFinalizer(() => worktrees.remove({ directory }).pipe(Effect.asVoid, Effect.orDie))
        yield* Effect.addFinalizer(() => jobs.cancelTree(child, revision).pipe(Effect.asVoid))
        yield* Deferred.succeed(opened, child)
        const descendant = yield* Deferred.await(ready)
        yield* Deferred.await(nested)
        expect(yield* jobs.get(descendant)).toBeUndefined()
        expect((yield* store.provide({ directory }, jobs.get(descendant)))?.status).toBe("running")
        expect(yield* store.provide({ directory }, jobs.get(child))).toBeUndefined()
        if (method === "completed" || method === "replaced") {
          expect((yield* jobs.wait({ id: child, timeout: 10000 })).info?.status).toBe("completed")
          expect(yield* Deferred.isDone(settled)).toBe(true)
          expect(yield* Deferred.isDone(stopped)).toBe(false)
        }
        const replacement = yield* method === "replaced"
          ? Effect.gen(function* () {
              const unrelated = yield* sessions.create({ title: "Unrelated newer parent" })
              const ready = yield* Deferred.make<void>()
              const next = yield* jobs.start({
                id: child,
                type: "task",
                metadata: { parentSessionId: unrelated.id, sessionId: child },
                origin: { sessionID: unrelated.id, messageID: MessageID.ascending(), callID: "new-generation" },
                run: Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never)),
              })
              if (!next.revision) throw new Error("Actual replacement revision required")
              const observed = next.revision
              yield* Deferred.await(ready)
              expect(observed).not.toBe(revision)
              yield* Effect.addFinalizer(() => jobs.cancelTree(child, observed).pipe(Effect.asVoid))
              const descendantjob = yield* store.provide({ directory }, jobs.get(descendant))
              if (!descendantjob?.revision) throw new Error("Actual descendant revision required")
              const selected = descendantjob.revision
              yield* Effect.addFinalizer(() =>
                store.provide({ directory }, jobs.cancelTree(descendant, selected)).pipe(Effect.asVoid),
              )
              return next
            })
          : Effect.succeed(undefined)
        if (method === "revision") expect(yield* jobs.cancelTree(child, revision)).toBe("cancelled")
        else {
          yield* runs.cancel(root.id)
          expect(yield* Deferred.isDone(done)).toBe(true)
          expect((yield* runs.inspect(root.id)).phase).toBe("idle")
        }
        if (replacement) {
          expect((yield* jobs.get(child))?.revision).toBe(replacement.revision)
          expect((yield* jobs.get(child))?.status).toBe("running")
          expect((yield* store.provide({ directory: other }, jobs.get(foreign.id)))?.status).toBe("running")
          expect(yield* Deferred.isDone(ended)).toBe(false)
        }
        expect(yield* Deferred.isDone(settled)).toBe(true)
        expect(yield* Deferred.isDone(stopped)).toBe(true)
        expect((yield* store.provide({ directory }, jobs.get(descendant)))?.status).toBe("cancelled")
        expect((yield* store.provide({ directory }, runs.inspect(child))).phase).toBe("idle")
        expect((yield* store.provide({ directory }, runs.inspect(descendant))).phase).toBe("idle")
        expect((yield* store.provide({ directory: other }, jobs.get(foreign.id)))?.status).toBe("running")
        expect(yield* Deferred.isDone(ended)).toBe(false)
        expect(yield* store.provide({ directory: other }, jobs.cancelTree(foreign.id, observed))).toBe("cancelled")
        expect(yield* Deferred.isDone(ended)).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false, mcp: {}, plugin: [] } },
    30000,
  )
