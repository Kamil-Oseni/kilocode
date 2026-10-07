import { expect } from "bun:test"
import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Storage } from "@/storage/storage"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { Git } from "@/git"
import { RayaGoal } from "@/kilocode/goal"
import { RayaGoalContinuation } from "@/kilocode/goal/continuation"
import { durable } from "@/kilocode/task/owner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Session.node, SessionProjector.node, Storage.node, CrossSpawnSpawner.node, FSUtil.node, Git.node]),
  ),
)

it.live("cold Routine restore retains a persisted abort without replay or execution acquisition", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const storage = yield* Storage.Service
      const goals = RayaGoal.make({ storage, sessions })
      const dead = yield* Effect.promise(async () => {
        const child = Bun.spawn({
          cmd: [
            process.execPath,
            "-e",
            "import { durable } from './src/kilocode/task/owner.ts'; console.log(JSON.stringify(durable()))",
          ],
          stdout: "pipe",
          stderr: "pipe",
        })
        const [text, err, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        if (code !== 0) throw new Error(err)
        return Schema.decodeUnknownSync(
          Schema.fromJsonString(Schema.Struct({ host: Schema.String, pid: Schema.Number, birth: Schema.String })),
        )(text)
      })
      expect(dead.birth).toBeDefined()
      for (const kind of [
        "aborted",
        "unfinished",
        "crashed",
        "missing",
        "tools",
        "owned",
        "unowned",
        "newer",
        "busy",
        "foreign",
      ] as const) {
        const agent = crypto.randomUUID()
        const run = crypto.randomUUID()
        const session = yield* sessions.create({
          metadata: {
            rayaRoutine: {
              version: kind === "crashed" ? 1 : 2,
              agentID: agent,
              runID: run,
              scheduleVersion: 1,
              trigger: { kind: "manual" },
            },
          },
        })
        if (kind !== "unowned")
          yield* storage.create(["raya", "agent-executions", createHash("sha256").update(run).digest("hex")], {
            version: 1,
            agentID: agent,
            runID: run,
            sessionID: session.id,
            token: crypto.randomUUID(),
            owner: kind === "owned" ? durable() : dead,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            state: "active",
          })
        yield* Effect.addFinalizer(() => goals.clear(session.id))
        yield* goals.create(session.id, "Retain uncertain work")
        const queued = yield* goals.continued(session.id)
        expect(queued?.dispatch).toBeDefined()
        const dispatch = queued!.dispatch!
        yield* goals.dispatched(session.id, dispatch.id)
        yield* sessions.updateMessage({
          id: dispatch.messageID!,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "code",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
        })
        const id = MessageID.ascending()
        if (kind !== "missing")
          yield* sessions.updateMessage({
            id,
            parentID: dispatch.messageID!,
            sessionID: session.id,
            role: "assistant",
            finish: kind === "tools" ? "tool-calls" : undefined,
            time: {
              created: Date.now(),
              completed:
                kind === "unfinished" || kind === "crashed" || kind === "owned" || kind === "unowned"
                  ? undefined
                  : Date.now(),
            },
            error:
              kind === "tools" || kind === "crashed"
                ? undefined
                : { name: "MessageAbortedError", data: { message: "Aborted" } },
            agent: "code",
            mode: "code",
            path: { cwd: session.directory, root: session.directory },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            providerID: ProviderV2.ID.make("test"),
            modelID: ModelV2.ID.make("test-model"),
          })
        if (kind === "newer") {
          const rows = yield* sessions.messages({ sessionID: session.id })
          const latest = rows.at(-1)!.info
          if (latest.role !== "assistant") throw new Error("Missing real assistant")
          yield* sessions.updateMessage({ ...latest, id: MessageID.ascending(), error: undefined })
        }
        const before = yield* goals.get(session.id)
        const restore = (bookkeeping = false) =>
          RayaGoalContinuation.restore({
            directory: kind === "foreign" ? session.directory + "/other" : session.directory,
            storage,
            sessions,
            bookkeeping,
            enabled: () => Effect.succeed(true),
            idle: () => Effect.succeed(kind !== "busy"),
            run: async () => {
              throw new Error("Unexpected replay")
            },
            loop: async () => {
              throw new Error("Unexpected replay")
            },
          })
        yield* restore(true)
        const after = yield* goals.get(session.id)
        if (kind === "aborted") {
          expect(after?.dispatch?.id).toBe(dispatch.id)
          expect(after?.dispatch?.phase).toBe("finished")
          expect(after?.dispatch?.outcome).toBe("interrupted")
          expect(after?.dispatch?.assistantID).toBe(id)
          expect(after?.status).toBe("active")
          expect(after?.usage).toEqual(before?.usage)
        }
        if (kind === "unfinished" || kind === "crashed" || kind === "missing" || kind === "tools") {
          expect(after?.status).toBe("blocked")
          expect(after?.blockedReason).toContain("may have finished")
          expect(after?.dispatch).toEqual(before?.dispatch)
          expect(after?.intent).toBe(before?.intent)
          expect(after?.objective).toBe(before?.objective)
          expect(after?.usage).toEqual(before?.usage)
        }
        if (kind === "owned" || kind === "unowned" || kind === "newer" || kind === "busy" || kind === "foreign")
          expect(after).toEqual(before)
        yield* restore()
        expect(yield* goals.get(session.id)).toEqual(after)
      }
    }),
  ),
)
