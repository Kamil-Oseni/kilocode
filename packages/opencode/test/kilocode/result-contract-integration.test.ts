import { expect } from "bun:test"
import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { Cause, Deferred, Effect, Exit } from "effect"
import z from "zod"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Database } from "@opencode-ai/core/database/database"
import { BackgroundOutcome } from "@opencode-ai/core/kilocode/background-outcome.sql"
import { ResultNotice } from "@opencode-ai/core/kilocode/result-notice.sql"
import { eq, sql } from "drizzle-orm"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import * as Outcome from "@/kilocode/background/outcome"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionProcessor } from "@/session/processor"
import * as SessionRunState from "@/session/run-state"
import { Execution } from "@/kilocode/effect/observation"
import { associate } from "@/kilocode/goal/turn"
import * as NativeRuntime from "@/session/llm/native-runtime"
import { MessageID, PartID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { ResultContract } from "@/kilocode/chief/result-contract"
import { RayaChief } from "@/kilocode/chief"
import { RayaGoal } from "@/kilocode/goal"
import { resumeHint } from "@/kilocode/task-resume"
import { RayaTaskExecution } from "@/kilocode/task/execution"
import * as Lineage from "@/kilocode/task/effect-lineage"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { database, storage } from "./fixtures/effect-profile"

function engine(native: boolean) {
  const flags = LayerNode.make({
    service: RuntimeFlags.Service,
    layer: RuntimeFlags.layer({
      experimentalNativeLlm: native,
      experimentalEventSystem: true,
      experimentalBackgroundSubagents: true,
    }),
    deps: [],
  })
  return testEffect(
    LayerNode.compile(
      LayerNode.group([
        Session.node,
        SessionPrompt.node,
        SessionProjector.node,
        Storage.node,
        FSUtil.node,
        Provider.node,
        RuntimeFlags.node,
        Truncate.node,
        Agent.node,
        Config.node,
        Permission.node,
        MCP.node,
        Plugin.node,
        ToolRegistry.node,
        SessionProcessor.node,
        SessionRunState.node,
        CrossSpawnSpawner.node,
        Database.node,
        Outcome.node,
        EventV2Bridge.node,
        BackgroundJob.node,
      ]),
      [
        [RuntimeFlags.node, flags],
        [Database.node, database],
        [Storage.node, storage],
      ],
    ),
  )
}
const model = { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("fixture") }
const names = ["café 日本語.txt", "résumé.json", "🚀.md"]
const modes = [
  "exact",
  "resume",
  "background",
  "background-goal",
  "background-goal-replaced",
  "no-read",
  "command",
  "failed",
  "truncated",
  "foreign",
  "stale",
  "narrative",
] as const

for (const run of [
  { name: "native", native: true, routine: false, it: engine(true), modes },
  { name: "sdk", native: false, routine: false, it: engine(false), modes: ["exact", "resume", "narrative"] as const },
  { name: "Routine native", native: true, routine: true, it: engine(true), modes: ["exact", "background"] as const },
  { name: "Routine sdk", native: false, routine: true, it: engine(false), modes: ["exact", "background"] as const },
])
  for (const mode of run.modes)
    run.it.instance(
      `actual Task and ${run.name} final LLM ${mode} result retain invocation-bound Read evidence`,
      () =>
        Effect.gen(function* () {
          const asynchronous = mode === "background" || mode.startsWith("background-goal")
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const jobs = yield* BackgroundJob.Service
          const instance = yield* TestInstance
          const context = yield* Effect.context()
          const directory = path.join(instance.directory, "observed")
          yield* Effect.promise(async () => {
            await mkdir(directory)
            for (const name of names) await writeFile(path.join(directory, name), "owned synthetic bytes")
          })
          const chat = yield* sessions.create({ title: `Observed-result ${mode}` })
          const request =
            mode === "narrative"
              ? "Use a read-only specialist to explain how directory inspection works. Return a short narrative."
              : `Use a read-only specialist to list the exact filenames in ${directory}. Return the names verbatim.`
          const state = { phase: 0, parent: 0, child: 0, waited: false, read: false, altered: false }
          const released = yield* Deferred.make<void>()
          const requests: unknown[] = []
          const trace: {
            phase: number
            owner: boolean
            user: number
            roles: string[]
            format: { parsed: boolean; text: boolean; count: number; refs: string[] }
            emitted?: string
          }[] = []
          const server = yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.serve({
                hostname: "127.0.0.1",
                port: 0,
                async fetch(incoming) {
                  if (new URL(incoming.url).pathname !== "/api/chat")
                    throw new Error("Unexpected owned provider endpoint")
                  const body = await incoming.json()
                  requests.push(body)
                  if (requests.length > 12) throw new Error("Owned provider request capacity exceeded")
                  const user = body.messages.findLast((row: { role: string; content: string }) => row.role === "user")
                  const owner = !body.messages.some(
                    (row: { role: string; content: string }) =>
                      row.role === "user" && row.content.includes("<subagent_brief>"),
                  )
                  const phase =
                    !asynchronous && mode !== "resume" ? state.phase++ : owner ? state.parent++ : 2 + state.child++
                  const schema = z
                    .object({
                      anyOf: z
                        .array(
                          z.object({
                            properties: z.object({
                              kind: z.object({ const: z.string() }),
                              content: z.object({ enum: z.array(z.string().max(8192)).max(128).optional() }).optional(),
                            }),
                          }),
                        )
                        .max(256),
                    })
                    .safeParse(body.format)
                  const branch = schema.success
                    ? schema.data.anyOf.find((item) => item.properties.kind.const === "text")
                    : undefined
                  const refs = branch?.properties.content?.enum ?? []
                  const entry: (typeof trace)[number] = {
                    phase,
                    owner,
                    user: user?.content.length ?? 0,
                    roles: body.messages.map((row: { role: string }) => row.role),
                    format: { parsed: schema.success, text: !!branch, count: refs.length, refs: refs.slice(0, 16) },
                  }
                  trace.push(entry)
                  const content = await Effect.runPromiseWith(context)(
                    Effect.gen(function* () {
                      // Actual background transport is held until the ORIGINAL
                      // parent prompt has returned and released its queue slot.
                      if (run.routine && asynchronous && !owner) yield* Deferred.await(released)
                      if (phase === 0)
                        return {
                          kind: "tool",
                          name: "chief_route",
                          arguments: {
                            objective: request,
                            access: "read",
                            result: mode === "narrative" ? "narrative" : "directory_entries",
                          },
                        }
                      if (mode.startsWith("background-goal") && owner && phase === 1)
                        return { kind: "tool", name: "create_goal", arguments: { objective: request } }
                      if (
                        (phase === 1 && !mode.startsWith("background-goal")) ||
                        (mode.startsWith("background-goal") && owner && phase === 2)
                      )
                        return {
                          kind: "tool",
                          name: "task",
                          arguments: {
                            description: "Inspect exact directory names",
                            brief: { objective: request },
                            access: "read",
                            step_cap: mode === "resume" ? 2 : 4,
                            ...(asynchronous ? { background: true } : {}),
                          },
                        }
                      if (mode === "resume" && owner && phase === 2) {
                        const children = yield* sessions.children(chat.id)
                        expect(children).toHaveLength(1)
                        const child = children[0]!
                        const parent = yield* sessions.messages({ sessionID: chat.id })
                        const calls = parent
                          .flatMap((row) => row.parts)
                          .filter((part) => part.type === "tool" && part.tool === "task")
                        expect(calls).toHaveLength(1)
                        const call = calls[0]!
                        if (call.type !== "tool" || call.state.status !== "error")
                          throw new Error("Actual failed first Task missing")
                        expect(call.state.error).toBe(`${ResultContract.unavailable}\n${resumeHint(child.id)}`)
                        const rows = yield* sessions.messages({ sessionID: child.id })
                        const terminal = rows.findLast((row) => row.info.role === "assistant")
                        expect(
                          terminal?.info.role === "assistant" &&
                            terminal.info.error?.name === "UnknownError" &&
                            terminal.info.error.data.message,
                        ).toBe(ResultContract.unavailable)
                        expect(
                          parent
                            .flatMap((row) => row.parts)
                            .some((part) => part.type === "text" && part.text.includes("Invented directory")),
                        ).toBe(false)
                        return {
                          kind: "tool",
                          name: "task",
                          arguments: {
                            description: "Resume exact directory inspection",
                            brief: { objective: request },
                            access: "read",
                            step_cap: 4,
                            task_id: child.id,
                          },
                        }
                      }
                      if (mode === "resume" && !owner) {
                        const children = yield* sessions.children(chat.id)
                        expect(children).toHaveLength(1)
                        const rows = yield* sessions.messages({ sessionID: children[0]!.id })
                        const users = rows.filter((row) => row.info.role === "user")
                        if (users.length === 1) {
                          state.read = true
                          return {
                            kind: "tool",
                            name: "read",
                            arguments: { filePath: path.join(directory, "missing") },
                          }
                        }
                        expect(users).toHaveLength(2)
                        const current = users.at(-1)!
                        const observed = rows.some(
                          (row) =>
                            row.info.role === "assistant" &&
                            row.info.parentID === current.info.id &&
                            row.parts.some(
                              (part) =>
                                part.type === "tool" && part.tool === "read" && part.state.status === "completed",
                            ),
                        )
                        if (!observed) return { kind: "tool", name: "read", arguments: { filePath: directory } }
                      }
                      if (
                        phase === 2 &&
                        !(asynchronous && owner) &&
                        mode !== "resume" &&
                        mode !== "no-read" &&
                        mode !== "command" &&
                        mode !== "narrative"
                      ) {
                        state.read = true
                        return {
                          kind: "tool",
                          name: "read",
                          arguments: {
                            filePath: mode === "failed" ? path.join(directory, "missing") : directory,
                            ...(mode === "truncated" ? { limit: 1 } : {}),
                          },
                        }
                      }
                      if (mode === "narrative") return { kind: "text", content: "Legitimate narrative summary." }
                      if (mode === "command")
                        return {
                          kind: "text",
                          content: JSON.stringify({ command: "Get-ChildItem", success: true, entries: ["invented"] }),
                        }
                      const children = yield* sessions.children(chat.id)
                      const child = children[0]
                      if (!child) return { kind: "text", content: "Invented directory listing and success." }
                      if (mode.startsWith("background-goal") && !owner) {
                        const rows = yield* sessions.messages({ sessionID: child.id })
                        const user = rows.findLast((row) => row.info.role === "user")
                        if (
                          !rows.some(
                            (row) =>
                              row.info.role === "assistant" &&
                              row.info.parentID === user?.info.id &&
                              row.parts.some(
                                (part) =>
                                  part.type === "tool" && part.tool === "read" && part.state.status === "completed",
                              ),
                          )
                        )
                          return { kind: "tool", name: "read", arguments: { filePath: directory } }
                      }
                      if (mode.startsWith("background-goal") && owner && phase === 3) {
                        expect(RayaChief.phase((yield* sessions.get(chat.id)).metadata)).toBe("task")
                        return {
                          kind: "tool",
                          name: "task",
                          arguments: {
                            task_id: child.id,
                            background: false,
                            brief: { objective: request },
                            access: "read",
                            step_cap: 4,
                          },
                        }
                      }
                      if (mode.startsWith("background-goal") && owner && phase === 4) {
                        const current = yield* sessions.get(chat.id)
                        expect(RayaChief.phase(current.metadata)).toBe("goal")
                        expect(RayaChief.history(current.metadata)).toHaveLength(1)
                        const proof = yield* ResultContract.load(sessions, chat.id)
                        if (!proof) throw new Error("Original continuation proof absent")
                        expect(RayaChief.history(current.metadata).at(-1)?.userID).toBe(
                          ResultContract.context(proof).input,
                        )
                        return { kind: "tool", name: "get_goal", arguments: {} }
                      }
                      if (asynchronous && owner) {
                        const parent = yield* sessions.messages({ sessionID: chat.id })
                        const notice = parent.findLast((row) => row.info.role === "user")
                        expect(
                          notice?.parts.some(
                            (part) => part.type === "text" && part.synthetic && part.text.startsWith("<task "),
                          ),
                        ).toBe(true)
                        expect((yield* jobs.get(child.id))?.status).toBe("completed")
                      }
                      const rows = yield* sessions.messages({ sessionID: child.id })
                      const row = rows.findLast((item) =>
                        item.parts.some(
                          (part) => part.type === "tool" && part.tool === "read" && part.state.status === "completed",
                        ),
                      )
                      const part = row?.parts.findLast(
                        (item) => item.type === "tool" && item.tool === "read" && item.state.status === "completed",
                      )
                      if (!row || !part || part.type !== "tool")
                        return { kind: "text", content: "Invented directory listing and success." }
                      if (mode === "stale" && !state.altered) {
                        state.altered = true
                        const user = yield* sessions.updateMessage({
                          id: MessageID.ascending(),
                          role: "user",
                          sessionID: child.id,
                          agent: "generalist",
                          model,
                          time: { created: Date.now() },
                        })
                        yield* sessions.updatePart({
                          id: PartID.ascending(),
                          messageID: user.id,
                          sessionID: child.id,
                          type: "text",
                          text: "A newer distinct invocation must not reuse the old result.",
                        })
                      }
                      if (mode.startsWith("background-goal") && owner && phase === 5) {
                        const parent = yield* sessions.messages({ sessionID: chat.id })
                        const get = parent
                          .flatMap((row) => row.parts)
                          .findLast(
                            (item) =>
                              item.type === "tool" && item.tool === "get_goal" && item.state.status === "completed",
                          )
                        if (get?.type !== "tool" || get.state.status !== "completed")
                          throw new Error("Actual goal evidence response missing")
                        const catalogue = z
                          .object({ eligibleEvidence: z.array(z.object({ callID: z.string() }).passthrough()) })
                          .passthrough()
                          .parse(JSON.parse(get.state.output))
                        expect(catalogue.eligibleEvidence.some((item) => item.callID === part.callID)).toBe(true)
                        return {
                          kind: "tool",
                          name: "update_goal",
                          arguments: {
                            status: "complete",
                            summary: "Verified original directory entries",
                            requirements: [
                              {
                                requirement: request,
                                passed: true,
                                evidence: [{ callID: part.callID, summary: "Actual full directory Read" }],
                              },
                            ],
                          },
                        }
                      }
                      return {
                        kind: "text",
                        content: JSON.stringify({
                          source: {
                            sessionID: mode === "foreign" ? chat.id : child.id,
                            messageID: row.info.id,
                            partID: part.id,
                            callID: part.callID,
                          },
                          format: "directory_entries",
                        }),
                      }
                    }),
                  )
                  if (
                    content.kind === "text" &&
                    asynchronous &&
                    owner &&
                    typeof content.content === "string" &&
                    content.content.length <= 8192
                  )
                    entry.emitted = content.content
                  return new Response(
                    [
                      {
                        model: body.model,
                        message: { role: "assistant", content: JSON.stringify(content) },
                        done: false,
                      },
                      { model: body.model, done: true, done_reason: "stop", prompt_eval_count: 32, eval_count: 8 },
                    ]
                      .map((row) => JSON.stringify(row))
                      .join("\n") + "\n",
                  )
                },
              }),
            ),
            (server) => Effect.promise(() => server.stop()),
          )
          const cfg = yield* Config.Service
          yield* cfg.update({
            snapshot: false,
            formatter: false,
            lsp: false,
            plugin: [],
            mcp: {},
            raya_routing: { confidence_threshold: 0 },
            permission: {
              "*": "deny",
              chief_route: "allow",
              task: "allow",
              read: "allow",
              create_goal: "allow",
              get_goal: "allow",
              update_goal: "allow",
            },
            enabled_providers: ["openai"],
            model: "openai/fixture",
            small_model: "openai/fixture",
            provider: {
              openai: {
                npm: "@ai-sdk/openai-compatible",
                env: [],
                options: {
                  baseURL: `${server.url}v1`,
                  apiKey: "owned-loopback-fixture",
                  localInference: true,
                  localInferenceAPI: "ollama",
                  localInferenceToolFormat: "completion-envelope-v1",
                },
                models: { fixture: { name: "Fixture", tool_call: true, limit: { context: 65536, output: 1024 } } },
              },
            },
            agent: {
              auto: { model: "openai/fixture", steps: 6 },
              generalist: { model: "openai/fixture", steps: 4 },
              researcher: { model: "openai/fixture", steps: 4 },
            },
          })
          if (run.native) {
            const provider = yield* Provider.Service
            const selected = yield* provider.getModel(model.providerID, model.modelID)
            const owner = yield* provider.getProvider(model.providerID)
            expect(NativeRuntime.status({ model: selected, provider: owner, auth: undefined }).type).toBe("supported")
            expect((yield* RuntimeFlags.Service).experimentalNativeLlm).toBe(true)
          }
          const dispatch = prompt.prompt({
            sessionID: chat.id,
            agent: "auto",
            model,
            parts: [{ type: "text", text: request }],
          })
          const outcome = yield* Effect.gen(function* () {
            if (!run.routine) return yield* dispatch
            // Genuine acquired owner on the selected physical DB/Storage; this
            // fixture seeds no positive SQL capability or Routine metadata.
            const storage = yield* Storage.Service
            const database = yield* Database.Service
            const selected = yield* database.db.all<{ name: string; file: string }>("PRAGMA database_list")
            expect(selected.find((row) => row.name === "main")?.file).toEndWith("authority.sqlite")
            const owner = { id: crypto.randomUUID(), agentID: crypto.randomUUID(), sessionID: chat.id }
            const execution = RayaTaskExecution.make(storage)
            const acquired = yield* execution.acquire(owner)
            expect(acquired).toBeDefined()
            const result = yield* execution.enter(
              owner,
              Effect.gen(function* () {
                expect(yield* Lineage.bind()).toBeDefined()
                const result = yield* dispatch
                yield* Deferred.succeed(released, undefined)
                return result
              }),
            )
            if (!result) throw new Error("Original Routine Task prompt did not execute")
            yield* execution.finish(owner)
            expect(yield* execution.receipt(owner)).toBeUndefined()
            return result
          }).pipe(Effect.exit)
          const children = yield* sessions.children(chat.id)
          const diagnose = () =>
            Effect.gen(function* () {
              const database = yield* Database.Service
              const saved = yield* sessions.get(chat.id)
              const rows = yield* sessions.messages({ sessionID: chat.id })
              const detail = {
                fixture: { engine: run.name, mode, state, trace, requests: requests.length },
                outcome: Exit.isFailure(outcome) ? Cause.pretty(outcome.cause).slice(0, 4096) : outcome.value.info,
                session: { id: saved.id, agent: saved.agent, metadata: saved.metadata },
                notices: {
                  count: yield* database.db
                    .select({ count: sql<number>`count(*)` })
                    .from(ResultNotice)
                    .where(eq(ResultNotice.sessionID, chat.id))
                    .get(),
                  rows: yield* database.db
                    .select({
                      messageID: ResultNotice.messageID,
                      userID: ResultNotice.userID,
                      jobID: ResultNotice.jobID,
                      revision: ResultNotice.revision,
                      callID: ResultNotice.callID,
                      inputID: ResultNotice.inputID,
                      sha: ResultNotice.sha,
                    })
                    .from(ResultNotice)
                    .where(eq(ResultNotice.sessionID, chat.id))
                    .limit(17)
                    .all(),
                },
                rows: rows.slice(-12).map((row) => ({
                  info: row.info,
                  parts: row.parts.slice(0, 32).map((part) =>
                    part.type === "tool"
                      ? {
                          id: part.id,
                          messageID: part.messageID,
                          sessionID: part.sessionID,
                          callID: part.callID,
                          type: part.type,
                          tool: part.tool,
                          state: part.state,
                        }
                      : part.type === "text"
                        ? { type: part.type, text: part.text.slice(0, 4096) }
                        : { type: part.type },
                  ),
                })),
                children: yield* Effect.forEach(children.slice(0, 4), (child) =>
                  Effect.gen(function* () {
                    const rows = yield* sessions.messages({ sessionID: child.id })
                    return {
                      id: child.id,
                      parentID: child.parentID,
                      job: yield* jobs.get(child.id),
                      durable: {
                        count: yield* database.db
                          .select({ count: sql<number>`count(*)` })
                          .from(BackgroundOutcome)
                          .where(eq(BackgroundOutcome.id, child.id))
                          .get(),
                        rows: yield* database.db
                          .select({
                            id: BackgroundOutcome.id,
                            revision: BackgroundOutcome.revision,
                            phase: BackgroundOutcome.phase,
                            identitySHA: BackgroundOutcome.identitySHA,
                            terminalSHA: BackgroundOutcome.terminalSHA,
                          })
                          .from(BackgroundOutcome)
                          .where(eq(BackgroundOutcome.id, child.id))
                          .limit(17)
                          .all(),
                      },
                      rows: rows.slice(-8).map((row) => ({
                        info: row.info,
                        parts: row.parts.slice(0, 16).map((part) =>
                          part.type === "tool"
                            ? {
                                id: part.id,
                                messageID: part.messageID,
                                sessionID: part.sessionID,
                                callID: part.callID,
                                type: part.type,
                                tool: part.tool,
                                state: part.state,
                              }
                            : part.type === "text"
                              ? { type: part.type, text: part.text.slice(0, 4096) }
                              : { type: part.type },
                        ),
                      })),
                    }
                  }),
                ),
              }
              yield* Effect.promise(async () => {
                const dir = path.resolve(import.meta.dir, "../../../../.tmp/new-pc")
                await mkdir(dir, { recursive: true })
                const file = path.join(
                  dir,
                  `result-contract-integration-${run.name}-${mode}-${Date.now()}-failure.json`,
                )
                const encoded = JSON.stringify(detail, null, 2)
                if (Buffer.byteLength(encoded) > 64 * 1024)
                  throw new Error("Owned integration diagnostic exceeds capacity")
                await writeFile(file, encoded, "utf8")
                console.error("Owned result-contract integration failure", file, detail.fixture, detail.outcome)
              })
            })
          if (
            children.length !== 1 ||
            Exit.isFailure(outcome) ||
            (outcome.value.info.role === "assistant" && outcome.value.info.error)
          )
            yield* diagnose()
          expect(children).toHaveLength(1)
          const child = children[0]!
          // Physical SQLite settlement and parent continuation share this bounded budget, not a five-second latency guarantee.
          const deadline = Date.now() + (mode.startsWith("background-goal") ? 180_000 : 30_000)
          if (asynchronous) {
            const completed = yield* jobs.wait({ id: child.id, timeout: Math.max(0, deadline - Date.now()) })
            if (completed.timedOut) yield* diagnose()
            expect(completed.timedOut).toBe(false)
            state.waited = true
          }
          const initial = yield* sessions.messages({ sessionID: child.id })
          const deliveries: typeof initial = []
          if (asynchronous) {
            while (true) {
              const parent = yield* sessions.messages({ sessionID: chat.id })
              const notice = parent.find(
                (row) =>
                  row.info.role === "user" &&
                  row.parts.some((part) => part.type === "text" && part.synthetic && part.text.startsWith("<task ")),
              )
              const terminal =
                notice &&
                parent.find(
                  (row) =>
                    row.info.role === "assistant" &&
                    row.info.parentID === notice.info.id &&
                    row.info.finish === "stop" &&
                    row.info.time.completed,
                )
              if (terminal) {
                deliveries.push(terminal)
                expect(terminal.info.role === "assistant" && terminal.info.error).toBeUndefined()
                const current = yield* sessions.messages({ sessionID: child.id })
                const evidence = current
                  .flatMap((row) => row.parts)
                  .findLast((part) => part.type === "tool" && part.tool === "read" && part.state.status === "completed")
                if (!evidence || evidence.type !== "tool" || evidence.state.status !== "completed")
                  throw new Error("Background completed Read missing")
                const display = z
                  .object({ type: z.literal("directory"), entries: z.array(z.string()) })
                  .passthrough()
                  .parse(evidence.state.metadata.display)
                expect(
                  terminal.parts
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join(""),
                ).toBe(display.entries.join("\n"))
                expect(
                  parent.filter(
                    (row) =>
                      row.info.role === "user" && row.parts.some((part) => part.type === "text" && !part.synthetic),
                  ),
                ).toHaveLength(1)
                expect(
                  parent.flatMap((row) => row.parts).filter((part) => part.type === "tool" && part.tool === "task"),
                ).toHaveLength(mode.startsWith("background-goal") ? 2 : 1)
                if (mode.startsWith("background-goal")) {
                  const goals = RayaGoal.make({ storage: yield* Storage.Service, sessions })
                  const goal = yield* goals.get(chat.id)
                  expect(goal?.status).toBe("complete")
                  expect(goal?.auditAttempt?.accepted).toBe(true)
                  const update = parent
                    .flatMap((row) => row.parts)
                    .findLast((part) => part.type === "tool" && part.tool === "update_goal")
                  if (update?.type !== "tool" || update.state.status !== "completed")
                    throw new Error("Accepted goal completion tool missing")
                  expect(update.state.metadata.status).toBe("complete")
                  if (mode === "background-goal-replaced") {
                    if (!goal?.intent || notice?.info.role !== "user")
                      throw new Error("Original completed goal or notice missing")
                    const runs = yield* SessionRunState.Service
                    yield* goals.stop(chat.id, goal.intent, runs)
                    const replacement = yield* goals.create(chat.id, request, notice.info.id)
                    expect(replacement.intent).not.toBe(goal.intent)
                    const saved = yield* goals.get(chat.id)
                    if (!saved) throw new Error("Persisted replacement goal missing")
                    const original = JSON.stringify(saved)
                    const count = parent.length
                    yield* runs.ensureRunning(
                      chat.id,
                      Effect.succeed(terminal),
                      Effect.gen(function* () {
                        const execution = yield* Effect.serviceOption(Execution)
                        expect(execution._tag).toBe("Some")
                        if (execution._tag === "None") throw new Error("Actual running execution absent")
                        const worker = yield* runs.inspect(chat.id)
                        expect(worker.phase === "running" && worker.id).toBe(execution.value.id)
                        yield* associate(goals, runs, chat.id, sessions)
                        const retained = yield* goals.get(chat.id)
                        expect(JSON.stringify(retained)).toBe(original)
                        expect(retained?.inputs?.includes(notice.info.id)).not.toBe(true)
                        expect(retained?.dispatch).toBeUndefined()
                        return terminal
                      }),
                    )
                    expect(
                      yield* sessions.messages({ sessionID: chat.id }).pipe(Effect.map((rows) => rows.length)),
                    ).toBe(count)
                  }
                }
                expect(state.waited).toBe(true)
                break
              }
              if (Date.now() >= deadline) {
                yield* diagnose()
                throw new Error("Genuine background completion notice was not confirmed")
              }
              yield* Effect.sleep(25)
            }
          }
          const rows = yield* sessions.messages({ sessionID: child.id })
          const reads = rows.flatMap((row) => row.parts).filter((part) => part.type === "tool" && part.tool === "read")
          const job = yield* jobs.get(child.id)
          expect(job?.status === "completed" || job?.status === "error").toBe(true)
          const original = yield* ResultContract.load(sessions, chat.id)
          expect(original?.kind).toBe(mode === "narrative" ? "narrative" : "directory_entries")
          expect(RayaChief.history((yield* sessions.get(chat.id)).metadata).at(-1)?.result).toBe(original?.kind)
          if (mode === "exact" || mode === "resume" || asynchronous || mode === "narrative") {
            expect(Exit.isSuccess(outcome)).toBe(true)
            if (!Exit.isSuccess(outcome)) throw Cause.squash(outcome.cause)
            expect(outcome.value.info.role === "assistant" && outcome.value.info.error).toBeUndefined()
            if (asynchronous) {
              expect(outcome.value.info.role === "assistant" && outcome.value.info.finish).toBe("tool-calls")
              expect(outcome.value.parts.filter((part) => part.type === "text")).toHaveLength(0)
              expect(deliveries).toHaveLength(1)
            }
            const answer = asynchronous ? deliveries[0]! : outcome.value
            const text = answer.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("")
            if (mode === "narrative") expect(text).toBe("Legitimate narrative summary.")
            expect(job?.status).toBe("completed")
            expect(reads).toHaveLength(
              mode === "narrative" ? 0 : mode === "resume" || mode.startsWith("background-goal") ? 2 : 1,
            )
            const parent = yield* sessions.messages({ sessionID: chat.id })
            const calls = parent
              .flatMap((row) => row.parts)
              .filter((part) => part.type === "tool" && part.tool === "task")
            expect(calls).toHaveLength(mode === "resume" || mode.startsWith("background-goal") ? 2 : 1)
            const call = calls.at(-1)!
            if (call.type !== "tool" || call.state.status !== "completed")
              throw new Error("Actual completed parent Task missing")
            expect(call.callID).not.toBeEmpty()
            expect(call.sessionID).toBe(chat.id)
            const metadata = call.state.metadata
            expect(metadata.sessionId).toBe(child.id)
            const invocation = rows.find((row) => row.info.id === metadata.childMessageID)
            expect(invocation?.info.role).toBe("user")
            expect(invocation?.info.sessionID).toBe(child.id)
            if (!invocation || invocation.info.role !== "user") throw new Error("Actual Task child invocation missing")
            expect(job?.origins).toContainEqual(
              expect.objectContaining({
                sessionID: chat.id,
                messageID: call.messageID,
                callID: call.callID,
                childSessionID: child.id,
                childMessageID: metadata.childMessageID,
              }),
            )
            if (mode === "exact" || mode === "resume" || asynchronous) {
              const read = reads.at(-1)!
              if (read.type !== "tool" || read.state.status !== "completed")
                throw new Error("Actual completed Read missing")
              const observed = rows.find((row) => row.info.id === read.messageID)
              expect(read.callID).not.toBeEmpty()
              expect(read.sessionID).toBe(child.id)
              expect(observed?.info.role).toBe("assistant")
              if (observed?.info.role !== "assistant") throw new Error("Actual Read assistant missing")
              expect(observed.info.parentID).toBe(invocation.info.id)
              const display = z
                .object({ type: z.literal("directory"), entries: z.array(z.string()) })
                .passthrough()
                .parse(read.state.metadata.display)
              expect(display.entries).toHaveLength(names.length)
              expect(new Set(display.entries)).toEqual(new Set(names))
              expect(text).toBe(display.entries.join("\n"))
              expect(state.read).toBe(true)
              if (mode === "resume") {
                const first = calls[0]!
                if (first.type !== "tool" || first.state.status !== "error")
                  throw new Error("Original failed Task changed")
                expect(first.state.error).toBe(`${ResultContract.unavailable}\n${resumeHint(child.id)}`)
                expect(call.state.input.task_id).toBe(child.id)
                expect(first.state.metadata?.childMessageID).not.toBe(metadata.childMessageID)
                expect(rows.filter((row) => row.info.role === "user")).toHaveLength(2)
                expect(
                  parent.filter(
                    (row) =>
                      row.info.role === "user" && row.parts.some((part) => part.type === "text" && !part.synthetic),
                  ),
                ).toHaveLength(1)
                const failed = reads[0]!
                expect(failed.type === "tool" && failed.state.status).toBe("error")
                const saved = yield* sessions.get(child.id)
                const proof = z
                  .object({
                    origin: z.object({ callID: z.string(), inputID: z.string() }),
                    task: z.object({ callID: z.string(), inputID: z.string() }),
                    continuations: z.array(z.object({ callID: z.string(), inputID: z.string() })),
                  })
                  .parse(saved.metadata?.[ResultContract.key])
                expect(proof.origin.callID).toBe(first.callID)
                expect(proof.origin.inputID).toBe(first.state.metadata?.childMessageID)
                expect(proof.task.callID).toBe(call.callID)
                expect(proof.task.inputID).toBe(metadata.childMessageID)
                expect(proof.continuations).toHaveLength(1)
                expect(proof.continuations[0]).toEqual(proof.origin)
                if (!original) throw new Error("Original resumed contract missing")
                const retained = yield* ResultContract.load(sessions, child.id)
                if (!retained) throw new Error("Actual resumed child contract missing")
                yield* ResultContract.check(sessions, original)
                yield* ResultContract.check(sessions, retained)
                return
              }
              if (asynchronous) {
                if (!original) throw new Error("Original background contract missing")
                const parent = yield* sessions.messages({ sessionID: chat.id })
                const notice = parent.find(
                  (row) =>
                    row.info.role === "user" &&
                    row.parts.some((part) => part.type === "text" && part.synthetic && part.text.startsWith("<task ")),
                )
                const part = notice?.parts.find((part) => part.type === "text" && part.synthetic)
                if (!part || part.type !== "text") throw new Error("Genuine background notice missing")
                yield* sessions.updatePart({ ...part, text: "Substituted same-ID background completion" })
                const refused = yield* ResultContract.check(sessions, original).pipe(Effect.exit)
                expect(Exit.isFailure(refused)).toBe(true)
                const loaded = yield* ResultContract.load(sessions, chat.id).pipe(Effect.exit)
                expect(Exit.isFailure(loaded)).toBe(true)
                yield* sessions.updatePart(part)
                yield* ResultContract.check(sessions, original)
                return
              }
              if (!original) throw new Error("Original completed contract missing")
              const inherited = yield* ResultContract.load(sessions, child.id)
              if (!inherited) throw new Error("Original inherited contract missing")
              const saved = yield* sessions.get(child.id)
              const proof = saved.metadata?.[ResultContract.key]
              if (!proof || typeof proof !== "object" || !("task" in proof))
                throw new Error("Actual inherited Task proof missing")
              const reject = (body: Effect.Effect<unknown, unknown>) =>
                body.pipe(
                  Effect.exit,
                  Effect.tap((value) => Effect.sync(() => expect(Exit.isFailure(value)).toBe(true))),
                )
              yield* reject(ResultContract.check(sessions, { ...inherited }))
              yield* sessions.setMetadata({
                sessionID: child.id,
                metadata: { ...saved.metadata, [ResultContract.key]: { ...proof, kind: "narrative" } },
              })
              yield* reject(ResultContract.load(sessions, child.id))
              yield* sessions.setMetadata({
                sessionID: child.id,
                metadata: { ...saved.metadata, [ResultContract.key]: { ...proof, continuations: [proof.task] } },
              })
              yield* reject(ResultContract.load(sessions, child.id))
              yield* sessions.setMetadata({ sessionID: child.id, metadata: saved.metadata ?? {} })
              const input = rows.findLast((row) => row.info.role === "user")
              const part = input?.parts.find((item) => item.type === "text")
              if (!part || part.type !== "text") throw new Error("Actual child user text missing")
              yield* sessions.updatePart({ ...part, text: "Substituted same-ID child invocation" })
              yield* reject(ResultContract.check(sessions, inherited))
              yield* sessions.updatePart(part)
              const latest = yield* sessions.messages({ sessionID: chat.id })
              const user = latest.findLast((row) => row.info.role === "user")
              const authored = user?.parts.find((item) => item.type === "text")
              if (!authored || authored.type !== "text") throw new Error("Actual parent user text missing")
              yield* sessions.updatePart({ ...authored, text: "Substituted same-ID original request" })
              yield* reject(ResultContract.check(sessions, original))
              yield* sessions.updatePart(authored)
              const route = latest
                .flatMap((row) => row.parts)
                .find((item) => item.type === "tool" && item.tool === "chief_route")
              if (!route || route.type !== "tool" || route.state.status !== "completed")
                throw new Error("Actual completed Chief result missing")
              yield* sessions.updatePart({
                ...route,
                state: { ...route.state, input: { ...route.state.input, result: "narrative" } },
              })
              yield* reject(ResultContract.check(sessions, original))
              yield* sessions.updatePart(route)
              yield* ResultContract.check(sessions, original)
              yield* ResultContract.check(sessions, inherited)
            }
            return
          }
          const error = Exit.isFailure(outcome)
            ? String(Cause.squash(outcome.cause))
            : outcome.value.info.role === "assistant"
              ? outcome.value.info.error
              : undefined
          const final = Exit.isSuccess(outcome)
            ? outcome.value.parts
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("")
            : undefined
          expect(error !== undefined || job?.status === "error" || final === ResultContract.unavailable).toBe(true)
          const parent = yield* sessions.messages({ sessionID: chat.id })
          expect(
            parent
              .flatMap((row) => row.parts)
              .some(
                (part) =>
                  part.type === "text" &&
                  (part.text.includes("Invented directory") ||
                    part.text.includes("Get-ChildItem") ||
                    part.text.includes('"source"')),
              ),
          ).toBe(false)
          expect(reads).toHaveLength(mode === "no-read" || mode === "command" ? 0 : 1)
        }),
      { config: { snapshot: false, plugin: [], mcp: {} } },
      mode.startsWith("background-goal") ? 210_000 : 60_000,
    )
