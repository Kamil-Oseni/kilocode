import { afterEach, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { AsyncResource } from "node:async_hooks"
import { Effect, Layer, Stream, Cause, Deferred, Fiber } from "effect"
import { LLMEvent } from "@opencode-ai/llm"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { Agent } from "@/agent/agent"
import { Instruction } from "@/session/instruction"
import { LSP } from "@/lsp/lsp"
import { Truncate } from "@/tool/truncate"
import { ReadTool } from "@/tool/read"
import { MessageID, PartID } from "@/session/schema"
import { RayaChief } from "@/kilocode/chief"
import { ResultContract } from "@/kilocode/chief/result-contract"
import { guard, guide, unavailable } from "@/kilocode/provider/result-contract"
import { format } from "@/kilocode/tool/read-directory"
import * as ResultFrame from "@/kilocode/provider/result-frame"
import * as OllamaPrompt from "@/kilocode/provider/ollama-prompt"
import { ollama } from "@/kilocode/provider/ollama-bridge"
import { ToolEnvelope } from "@/kilocode/provider/tool-envelope"
import { z } from "zod"
import { testEffect } from "../../lib/effect"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../../fixture/fixture"

afterEach(disposeAllInstances)
const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        Agent.node,
        FSUtil.node,
        CrossSpawnSpawner.node,
        Instruction.node,
        LSP.node,
        Ripgrep.node,
        Truncate.node,
        Session.node,
        SessionProjector.node,
        Storage.node,
        Database.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)
const model = { providerID: ProviderV2.ID.make("fixture"), modelID: ModelV2.ID.make("fixture") }
const names = ["résumé-original-Ω.txt", "coder-exact-目录/"]

// Controlled persisted Chief dispatch; Read and Session storage are actual production implementations.
const fixture = Effect.fn(function* (dir: string, read = true, entries: readonly string[] = names) {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "Owned exact result" })
  const user = MessageID.ascending()
  const message = MessageID.ascending()
  const start = Date.now()
  const request = "Inspect the owned directory and return its original entries"
  const decision: RayaChief.Decision = {
    request,
    access: "read",
    result: "directory_entries",
    userID: user,
    agent: "generalist",
    model: "fixture/fixture",
    needs_plan: false,
    confidence: 1,
    reason: "Owned fixture",
    latency: 0,
    chiefModel: "fixture/fixture",
    candidates: [],
    prompted: false,
  }
  const metadata = { [RayaChief.requestKey]: request, [RayaChief.phaseKey]: "task", [RayaChief.logKey]: [decision] }
  yield* sessions.updateMessage({
    id: user,
    sessionID: chat.id,
    role: "user",
    agent: "auto",
    model,
    time: { created: start },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: user,
    sessionID: chat.id,
    type: "text",
    text: request,
  })
  yield* sessions.updateMessage({
    id: message,
    sessionID: chat.id,
    role: "assistant",
    parentID: user,
    agent: "auto",
    mode: "auto",
    providerID: model.providerID,
    modelID: model.modelID,
    cost: 0,
    path: { cwd: dir, root: dir },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: start },
  })
  yield* sessions.setMetadata({ sessionID: chat.id, metadata })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: message,
    sessionID: chat.id,
    type: "tool",
    tool: "chief_route",
    callID: "owned-route",
    state: {
      status: "completed",
      input: { access: "read", result: "directory_entries", objective: request },
      title: "Owned route",
      output: JSON.stringify(decision),
      metadata: {},
      time: { start, end: Date.now() },
    },
  })
  const review = yield* ResultContract.load(sessions, { sessionID: chat.id, userID: user, messageID: message })
  if (!review) throw new Error("Owned contract unavailable")
  const part = PartID.ascending()
  const observe = Effect.fn(function* (file: string, id: PartID, call: string) {
    const tool = yield* ReadTool
    const active = yield* tool.init()
    const output = yield* active.execute(
      { filePath: file },
      {
        sessionID: chat.id,
        messageID: message,
        callID: call,
        agent: "generalist",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      },
    )
    yield* sessions.updatePart({
      id,
      messageID: message,
      sessionID: chat.id,
      type: "tool",
      tool: "read",
      callID: call,
      state: {
        status: "completed",
        input: { filePath: file },
        title: output.title,
        output: output.output,
        metadata: output.metadata,
        time: { start, end: Date.now() },
      },
    })
  })
  if (read) {
    yield* Effect.promise(() =>
      Promise.all(
        entries.map((name) =>
          name.endsWith("/") ? fs.mkdir(path.join(dir, name)) : fs.writeFile(path.join(dir, name), "Owned contents"),
        ),
      ),
    )
    yield* observe(dir, part, "owned-read")
  }
  return {
    sessions,
    review,
    chat,
    user,
    message,
    part,
    metadata,
    observe,
    source: { sessionID: chat.id, messageID: message, partID: part, callID: "owned-read" },
  }
})

it.live("rejects same-source metadata and canonical-output substitution after the guide", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const f = yield* fixture(dir)
        yield* guide(f.sessions, f.review)
        const rows = yield* f.sessions.messages({ sessionID: f.chat.id })
        const part = rows.flatMap((row) => row.parts).find((part) => part.id === f.part)
        if (part?.type !== "tool" || part.state.status !== "completed") throw new Error("Owned Read missing")
        const display = {
          type: "directory",
          path: dir,
          entries: ["altered-name.txt"],
          offset: 1,
          totalEntries: 1,
          truncated: false,
        }
        yield* f.sessions.updatePart({
          ...part,
          state: { ...part.state, metadata: { ...part.state.metadata, display }, output: format(display) },
        })
        const shown: string[] = []
        const result = yield* guard(
          final(JSON.stringify({ source: f.source, format: "directory_entries" })),
          f.review,
          f.sessions,
        ).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              if (event.type === "text-delta") shown.push(event.text)
            }),
          ),
          Stream.runDrain,
          Effect.exit,
        )
        expect(result._tag).toBe("Failure")
        expect(shown).toEqual([])
      }),
    )
  }),
)

it.live("retains an unchanged source across a distinct path but refuses a superseded listing", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const f = yield* fixture(dir)
        yield* guide(f.sessions, f.review)
        const sibling = path.join(dir, "distinct-directory")
        yield* Effect.promise(() => fs.mkdir(sibling))
        yield* f.observe(sibling, PartID.ascending(), "distinct-read")
        const events = yield* guard(
          final(JSON.stringify({ source: f.source, format: "directory_entries" })),
          f.review,
          f.sessions,
        ).pipe(Stream.runCollect)
        expect(
          events
            .filter(LLMEvent.is.textDelta)
            .map((event) => event.text)
            .join(""),
        ).toBe(names.toSorted().join("\n"))
        yield* f.observe(dir, PartID.ascending(), "newer-same-path-read")
        const shown: string[] = []
        const result = yield* guard(
          final(JSON.stringify({ source: f.source, format: "directory_entries" })),
          f.review,
          f.sessions,
        ).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              if (event.type === "text-delta") shown.push(event.text)
            }),
          ),
          Stream.runDrain,
          Effect.exit,
        )
        expect(result._tag).toBe("Failure")
        expect(shown).toEqual([])
      }),
    )
  }),
)

function final(text: string) {
  return Stream.fromIterable([
    LLMEvent.textStart({ id: "model" }),
    LLMEvent.textDelta({ id: "model", text }),
    LLMEvent.textEnd({ id: "model" }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ])
}

const options = {
  localInference: true,
  localInferenceAPI: "ollama",
  localInferenceToolFormat: "completion-envelope-v1",
}
const body = () => ({
  model: "fixture",
  messages: [{ role: "user" as const, content: "Owned exact result" }],
  tools: [
    {
      type: "function" as const,
      function: {
        name: "read",
        parameters: {
          type: "object",
          properties: { filePath: { type: "string" } },
          required: ["filePath"],
          additionalProperties: false,
        },
      },
    },
  ],
  tool_choice: "auto" as const,
  stream: true,
})
const posted = z
  .object({ messages: z.array(z.record(z.string(), z.unknown())), format: z.record(z.string(), z.unknown()) })
  .passthrough()

it.live("constrains a real native acquisition POST and preserves final-only no-evidence refusal", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const f = yield* fixture(dir, false)
        const frame = yield* ResultFrame.create(f.sessions, f.review)
        if (!frame) throw new Error("Owned frame unavailable")
        expect(ResultFrame.selected(frame)).toEqual([])
        expect(() => ResultFrame.selected({ kind: "directory_entries" })).toThrow()
        const requests: z.infer<typeof posted>[] = []
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            requests.push(posted.parse(await request.json()))
            return new Response(
              JSON.stringify({
                model: "fixture",
                message: {
                  role: "assistant",
                  content: JSON.stringify({ kind: "tool", name: "read", arguments: { filePath: dir } }),
                },
                done: true,
                done_reason: "stop",
              }) + "\n",
            )
          },
        })
        try {
          const request = body()
          const bridge = ollama(options, globalThis.fetch)
          const response = yield* Effect.promise(() =>
            ResultFrame.run(frame, () =>
              bridge(`http://127.0.0.1:${server.port}/chat/completions`, {
                method: "POST",
                body: JSON.stringify(request),
              }),
            ),
          )
          expect(yield* Effect.promise(() => response.text())).toContain("tool_calls")
          expect(requests).toHaveLength(1)
          expect(requests[0].messages).toEqual(
            OllamaPrompt.project(request.messages, request.tools, true, "auto", false, frame),
          )
          expect(requests[0].format).toEqual(OllamaPrompt.format(request.tools, "auto", frame))
          expect(JSON.stringify(requests[0].format)).not.toContain('"const":"text"')
          expect(() =>
            ToolEnvelope.decode(
              JSON.stringify({ kind: "text", content: "Invented completion" }),
              new Set(["read"]),
              "auto",
              ResultFrame.selected(frame),
            ),
          ).toThrow()
          const terminal = yield* ResultFrame.create(f.sessions, f.review)
          if (!terminal) throw new Error("Owned final frame unavailable")
          for (const choice of ["none", "auto", "required"] as const) {
            const admission = yield* Effect.try({
              try: () => OllamaPrompt.format([], choice, terminal),
              catch: (err) => err,
            }).pipe(Effect.exit)
            expect(admission._tag).toBe("Failure")
            if (admission._tag === "Failure") {
              const err = Cause.squash(admission.cause)
              expect(err).toBeInstanceOf(Error)
              expect(err).toMatchObject({ name: "OllamaEvidenceError", message: unavailable, isRetryable: false })
            }
          }
          expect(() => OllamaPrompt.format(request.tools, "none", terminal)).toThrow(unavailable)
          expect(JSON.stringify(OllamaPrompt.format(request.tools, "required", terminal))).not.toContain(
            '"const":"text"',
          )
          expect(() => ToolEnvelope.schema([], "required")).toThrow("Invalid envelope tool definitions")
          const refused = yield* Effect.tryPromise(() =>
            ResultFrame.run(terminal, () =>
              bridge(`http://127.0.0.1:${server.port}/chat/completions`, {
                method: "POST",
                body: JSON.stringify({ ...request, tools: [], tool_choice: "none" }),
              }),
            ),
          ).pipe(Effect.exit)
          expect(refused._tag).toBe("Failure")
          if (refused._tag === "Failure") expect(Cause.pretty(refused.cause)).toContain(unavailable)
          expect(requests).toHaveLength(1)
          const controller = new AbortController()
          controller.abort()
          const cancelled = yield* ResultFrame.create(f.sessions, f.review)
          if (!cancelled) throw new Error("Owned cancellation frame unavailable")
          let calls = 0
          const stopped = yield* Effect.tryPromise(() =>
            ResultFrame.run(
              cancelled,
              () => {
                calls++
                return bridge(`http://127.0.0.1:${server.port}/chat/completions`, {
                  method: "POST",
                  body: JSON.stringify(request),
                })
              },
              controller.signal,
            ),
          ).pipe(Effect.exit)
          expect(stopped._tag).toBe("Failure")
          expect(calls).toBe(0)
          expect(requests).toHaveLength(1)
        } finally {
          server.stop(true)
        }
      }),
    )
  }),
)

it.live("uses exact native reference enums, rejects scripted violations and fences leaked contexts", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const f = yield* fixture(dir)
        const frame = yield* ResultFrame.create(f.sessions, f.review)
        if (!frame) throw new Error("Owned frame unavailable")
        const ref = JSON.stringify({ source: f.source, format: "directory_entries" })
        expect(ResultFrame.selected(frame)).toEqual([ref])
        const requests: z.infer<typeof posted>[] = []
        const state = { content: ref }
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            requests.push(posted.parse(await request.json()))
            return new Response(
              JSON.stringify({
                model: "fixture",
                message: { role: "assistant", content: JSON.stringify({ kind: "text", content: state.content }) },
                done: true,
                done_reason: "stop",
              }) + "\n",
            )
          },
        })
        try {
          const bridge = ollama(options, globalThis.fetch)
          const request = { ...body(), tools: [], tool_choice: "none" as const }
          const response = yield* Effect.promise(() =>
            ResultFrame.run(frame, () =>
              bridge(`http://127.0.0.1:${server.port}/chat/completions`, {
                method: "POST",
                body: JSON.stringify(request),
              }),
            ),
          )
          expect(yield* Effect.promise(() => response.text())).toContain("directory_entries")
          expect(requests[0].messages).toEqual(
            OllamaPrompt.project(request.messages, request.tools, true, "none", false, frame),
          )
          expect(requests[0].format).toEqual(OllamaPrompt.format(request.tools, "none", frame))
          expect(JSON.stringify(requests[0].format)).toContain(JSON.stringify(ref))
          state.content = "Rewritten unverified filenames"
          const invalid = yield* ResultFrame.create(f.sessions, f.review)
          if (!invalid) throw new Error("Owned refusal frame unavailable")
          const refused = yield* Effect.tryPromise(() =>
            ResultFrame.run(invalid, () =>
              bridge(`http://127.0.0.1:${server.port}/chat/completions`, {
                method: "POST",
                body: JSON.stringify(request),
              }),
            ),
          ).pipe(Effect.exit)
          expect(refused._tag).toBe("Failure")
          let later = () => ResultFrame.current()
          const original = yield* ResultFrame.create(f.sessions, f.review)
          if (!original) throw new Error("Owned scope frame unavailable")
          yield* Effect.promise(() =>
            ResultFrame.run(original, async () => {
              later = AsyncResource.bind(() => ResultFrame.current())
              expect(ResultFrame.current()).toBe(original)
            }),
          )
          expect(() => later()).toThrow()
          expect(ResultFrame.current()).toBeUndefined()
          const ordinary = yield* Effect.promise(() =>
            ResultFrame.run(undefined, () =>
              bridge(`http://127.0.0.1:${server.port}/chat/completions`, {
                method: "POST",
                body: JSON.stringify(request),
              }),
            ),
          )
          expect(yield* Effect.promise(() => ordinary.text())).toContain(state.content)
          expect(requests.at(-1)?.format).toEqual(OllamaPrompt.format([], "none"))
        } finally {
          server.stop(true)
        }
      }),
    )
  }),
)

it.live("renders exact actual Read entries and publishes only after original stream EOF", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const f = yield* fixture(dir)
        expect(yield* guide(f.sessions, f.review)).toContain(JSON.stringify(f.source))
        let closed = false
        const input = final(JSON.stringify({ source: f.source, format: "directory_entries" })).pipe(
          Stream.ensuring(
            Effect.sync(() => {
              closed = true
            }),
          ),
        )
        const events = yield* guard(input, f.review, f.sessions).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              if (event.type === "text-delta") expect(closed).toBe(true)
            }),
          ),
          Stream.runCollect,
        )
        expect(
          events
            .filter(LLMEvent.is.textDelta)
            .map((event) => event.text)
            .join(""),
        ).toBe(names.toSorted().join("\n"))
        expect(events.filter(LLMEvent.is.finish)).toHaveLength(1)
        expect(events.filter(LLMEvent.is.textDelta).some((event) => event.text.includes("source"))).toBe(false)
      }),
    )
  }),
)

it.live("does not publish invented finals or forged references", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const f = yield* fixture(dir)
        for (const text of [
          "I listed the directory successfully",
          JSON.stringify({ source: { ...f.source, callID: "invented" }, format: "directory_entries" }),
          JSON.stringify({ source: f.source, format: "directory_entries", command: "do something" }),
          "Ω".repeat(4097),
        ]) {
          const shown: string[] = []
          const result = yield* guard(final(text), f.review, f.sessions).pipe(
            Stream.tap((event) =>
              Effect.sync(() => {
                if (event.type === "text-delta") shown.push(event.text)
              }),
            ),
            Stream.runDrain,
            Effect.exit,
          )
          expect(result._tag).toBe("Failure")
          expect(shown).toEqual([])
        }
        const rows = yield* f.sessions.messages({ sessionID: f.chat.id })
        const part = rows.flatMap((row) => row.parts).find((part) => part.id === f.part)
        if (part?.type !== "tool" || part.state.status !== "completed") throw new Error("Owned Read missing")
        yield* f.sessions.updatePart({ ...part, state: { ...part.state, output: "changed persisted Read output" } })
        expect(
          (yield* guard(
            final(JSON.stringify({ source: f.source, format: "directory_entries" })),
            f.review,
            f.sessions,
          ).pipe(Stream.runDrain, Effect.exit))._tag,
        ).toBe("Failure")
      }),
    )
  }),
)

it.live("uses precise no-evidence refusal and passes tool calls without model commentary", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const f = yield* fixture(dir, false)
        const refused = yield* guard(final("I completed it"), f.review, f.sessions).pipe(Stream.runDrain, Effect.exit)
        expect(refused._tag).toBe("Failure")
        if (refused._tag === "Failure") expect(Cause.pretty(refused.cause)).toContain(unavailable)
        const input = Stream.fromIterable([
          LLMEvent.textStart({ id: "model" }),
          LLMEvent.textDelta({ id: "model", text: "Unverified success" }),
          LLMEvent.textEnd({ id: "model" }),
          LLMEvent.toolCall({ id: "acquire", name: "read", input: { filePath: dir } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ])
        const events = yield* guard(input, f.review, f.sessions).pipe(Stream.runCollect)
        expect(events.filter(LLMEvent.is.toolCall)).toHaveLength(1)
        expect(events.filter(LLMEvent.is.textDelta)).toEqual([])
        expect(events.filter(LLMEvent.is.finish)[0]?.reason).toBe("tool-calls")
      }),
    )
  }),
)

it.live("accepts original native settlements after provider finish and retains the EOF gate", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const f = yield* fixture(dir, false)
        const prefix = [
          LLMEvent.toolCall({ id: "acquire", name: "read", input: { filePath: dir } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ]
        const result = LLMEvent.toolResult({
          id: "acquire",
          name: "read",
          result: { type: "text", value: "Owned result" },
        })
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const seen: LLMEvent[] = []
        let closed = false
        const input = Stream.fromIterable([...prefix, result]).pipe(
          Stream.concat(
            Stream.fromEffectDrain(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))),
          ),
          Stream.ensuring(
            Effect.sync(() => {
              closed = true
            }),
          ),
        )
        const run = yield* guard(input, f.review, f.sessions).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              seen.push(event)
            }),
          ),
          Stream.runDrain,
          Effect.forkChild,
        )
        yield* Deferred.await(entered)
        expect(seen.filter(LLMEvent.is.toolResult)).toHaveLength(1)
        expect(seen.filter(LLMEvent.is.finish)).toHaveLength(0)
        expect(closed).toBe(false)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(run)
        expect(closed).toBe(true)
        expect(seen.filter(LLMEvent.is.finish)).toHaveLength(1)
        const error = LLMEvent.toolError({ id: "acquire", name: "read", message: "Owned refusal" })
        const refused = LLMEvent.toolResult({
          id: "acquire",
          name: "read",
          result: { type: "error", value: "Owned refusal" },
        })
        expect(
          (yield* guard(Stream.fromIterable([...prefix, error, refused]), f.review, f.sessions).pipe(
            Stream.runDrain,
            Effect.exit,
          ))._tag,
        ).toBe("Success")
        for (const tail of [
          [LLMEvent.toolResult({ id: "foreign", name: "read", result: { type: "text", value: "Unrelated" } })],
          [LLMEvent.toolResult({ id: "acquire", name: "task", result: { type: "text", value: "Wrong tool" } })],
          [result, result],
          [error, error],
          [result, error],
          [LLMEvent.finish({ reason: "tool-calls" })],
          [LLMEvent.textStart({ id: "late" })],
          [LLMEvent.toolCall({ id: "late", name: "read", input: { filePath: dir } })],
        ]) {
          expect(
            (yield* guard(Stream.fromIterable([...prefix, ...tail]), f.review, f.sessions).pipe(
              Stream.runDrain,
              Effect.exit,
            ))._tag,
          ).toBe("Failure")
        }
      }),
    )
  }),
)

it.live("refuses cancellation, missing terminal EOF and changed current request", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const f = yield* fixture(dir)
        const text = JSON.stringify({ source: f.source, format: "directory_entries" })
        const controller = new AbortController()
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const done = yield* Deferred.make<void>()
        let closed = false
        const shown: string[] = []
        const cancelled = Stream.fromIterable([
          LLMEvent.textStart({ id: "model" }),
          LLMEvent.textDelta({ id: "model", text }),
          LLMEvent.textEnd({ id: "model" }),
        ]).pipe(
          Stream.concat(
            Stream.fromEffect(
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
                return LLMEvent.finish({ reason: "stop" })
              }),
            ),
          ),
          Stream.ensuring(
            Effect.sync(() => {
              closed = true
            }),
          ),
        )
        const run = yield* guard(cancelled, f.review, f.sessions, controller.signal).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              if (event.type === "text-delta") shown.push(event.text)
            }),
          ),
          Stream.runDrain,
          Effect.exit,
          Effect.ensuring(Deferred.succeed(done, undefined)),
          Effect.forkChild,
        )
        yield* Deferred.await(entered)
        controller.abort()
        expect(yield* Deferred.isDone(done)).toBe(false)
        expect(closed).toBe(false)
        yield* Deferred.succeed(release, undefined)
        expect((yield* Fiber.join(run))._tag).toBe("Failure")
        expect(closed).toBe(true)
        expect(shown).toEqual([])
        const missing = Stream.fromIterable([
          LLMEvent.textStart({ id: "model" }),
          LLMEvent.textDelta({ id: "model", text }),
          LLMEvent.textEnd({ id: "model" }),
        ])
        expect((yield* guard(missing, f.review, f.sessions).pipe(Stream.runDrain, Effect.exit))._tag).toBe("Failure")
        const changed = final(text).pipe(
          Stream.ensuring(
            f.sessions.updateMessage({
              id: MessageID.ascending(),
              sessionID: f.chat.id,
              role: "user",
              agent: "auto",
              model,
              time: { created: Date.now() },
            }),
          ),
        )
        expect((yield* guard(changed, f.review, f.sessions).pipe(Stream.runDrain, Effect.exit))._tag).toBe("Failure")
      }),
    )
  }),
)

for (const count of [0, 256]) {
  it.live(`renders an actual complete ${count}-entry directory without adding text`, () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* provideInstance(dir)(
        Effect.gen(function* () {
          const entries = Array.from(
            { length: count },
            (_, index) => `original-Ω-${index.toString().padStart(3, "0")}.txt`,
          )
          const f = yield* fixture(dir, true, entries)
          const events = yield* guard(
            final(JSON.stringify({ source: f.source, format: "directory_entries" })),
            f.review,
            f.sessions,
          ).pipe(Stream.runCollect)
          expect(
            events
              .filter(LLMEvent.is.textDelta)
              .map((event) => event.text)
              .join(""),
          ).toBe(entries.join("\n"))
          expect(events.filter(LLMEvent.is.finish)).toHaveLength(1)
        }),
      )
    }),
  )
}
