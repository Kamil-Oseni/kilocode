import { expect } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { MessageV2 } from "@/session/message-v2"
import type { Provider } from "@/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { KiloReadObject } from "@/kilocode/tool/read-object"
import * as Artifact from "@/kilocode/goal/artifact"
import { read } from "@/kilocode/goal/read-artifact"
import { ReadTool } from "@/tool/read"
import { Agent } from "@/agent/agent"
import { Instruction } from "@/session/instruction"
import { LSP } from "@/lsp/lsp"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { MessageID, SessionID, PartID } from "@/session/schema"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const model: Provider.Model = {
  id: ModelV2.ID.make("test-model"),
  providerID: ProviderV2.ID.make("test"),
  api: {
    id: "test-model",
    url: "https://example.com/v1",
    npm: "@ai-sdk/openai",
  },
  name: "Test model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, output: 32_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, CrossSpawnSpawner.node])))

it.live("propagates tool cancellation instead of recording a completed read revision", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    const file = path.join(directory, "abort.txt")
    yield* fs.writeFileString(file, "bytes")
    const info = yield* KiloReadObject.file(file)
    const controller = new AbortController()
    const exit = yield* KiloReadObject.use(info, (bound) =>
      read(
        fs,
        bound,
        Effect.sync(() => {
          controller.abort()
          return { metadata: {}, output: "read" }
        }),
        controller.signal,
      ),
    ).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
  }),
)
const tool = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      FSUtil.node,
      Instruction.node,
      LSP.node,
      Truncate.node,
      CrossSpawnSpawner.node,
      Ripgrep.node,
    ]),
  ),
)

tool.instance(
  "real partial reads retain revision and display coverage while directory reads remain untagged",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const fs = yield* FSUtil.Service
      const file = path.join(instance.directory, "partial.txt")
      yield* fs.writeFileString(file, "first\nsecond\nthird\n")
      const info = yield* ReadTool
      const reader = yield* info.init()
      const ctx = {
        sessionID: SessionID.make("ses_artifact_read"),
        messageID: MessageID.make("msg_artifact_read"),
        callID: "read",
        agent: "code",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const result = yield* reader.execute({ filePath: file, limit: 1 }, ctx)
      expect(result.metadata.truncated).toBe(true)
      expect(result.metadata.display).toMatchObject({ lineStart: 1, lineEnd: 1 })
      expect(yield* Artifact.current(result.metadata.rayaRevision)).toBe(true)
      yield* fs.writeFileString(file, "first\nsecond\nchanged\n")
      expect(yield* Artifact.current(result.metadata.rayaRevision)).toBe(false)
      const fresh = yield* reader.execute({ filePath: file }, ctx)
      expect(yield* Artifact.current(fresh.metadata.rayaRevision)).toBe(true)
      const directory = yield* reader.execute({ filePath: instance.directory }, ctx)
      expect(directory.metadata.rayaRevision).toBeUndefined()
      expect(directory.output).not.toContain("<file-format")
    }),
  30_000,
)

it.live("binds read evidence to the inspected object and detects changes during and after reading", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    const file = path.join(directory, "read.txt")
    for (const changed of [false, true]) {
      yield* fs.writeFileString(file, "original bytes")
      const info = yield* KiloReadObject.file(file)
      const result = yield* KiloReadObject.use(info, (bound) =>
        read(
          fs,
          bound,
          Effect.gen(function* () {
            const bytes = yield* Effect.tryPromise(() => bound.read())
            if (changed) yield* fs.writeFileString(file, "modified bytes")
            return { output: bytes.toString(), metadata: { truncated: false, display: { type: "file" } } }
          }),
        ),
      )
      expect(result.output.startsWith("original bytes")).toBe(true)
      expect(result.output.includes("<file-format")).toBe(!changed)
      expect(result.metadata.rayaRevision.status).toBe(changed ? "unavailable" : "captured")
      expect(yield* Artifact.current(result.metadata.rayaRevision)).toBe(!changed)
      if (changed) continue
      yield* fs.writeFileString(path.join(directory, "unrelated.txt"), "another file")
      expect(yield* Artifact.current(result.metadata.rayaRevision)).toBe(true)
      yield* fs.writeFileString(file, "modified bytes")
      expect(yield* Artifact.current(result.metadata.rayaRevision)).toBe(false)
    }
  }),
)

tool.instance(
  "real text reads expose authorized format and SHA in model history independently of numbered display lines",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const fs = yield* FSUtil.Service
      const info = yield* ReadTool
      const reader = yield* info.init()
      const ctx = {
        sessionID: SessionID.make("ses_format_read"),
        messageID: MessageID.make("msg_format_read"),
        callID: "read",
        agent: "code",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const cases = [
        { text: "", endings: "none", newline: false, bom: "none" },
        { text: "plain", endings: "none", newline: false, bom: "none" },
        { text: "first\nlast", endings: "LF", newline: false, bom: "none" },
        { text: "first\nlast\n", endings: "LF", newline: true, bom: "none" },
        { text: "first\r\nlast\r\n", endings: "CRLF", newline: true, bom: "none" },
        { text: "first\rlast\r", endings: "CR", newline: true, bom: "none" },
        { text: "first\r\nlast\n", endings: "mixed", newline: true, bom: "none" },
        { text: "\ufeffcafé\n", endings: "LF", newline: true, bom: "UTF-8" },
        // The multibyte character crosses the bound reader's 64 KiB chunk boundary.
        { text: "a".repeat(65535) + "é\r\n", endings: "CRLF", newline: true, bom: "none" },
      ]
      for (const [index, row] of cases.entries()) {
        const file = path.join(instance.directory, `format-${index}.txt`)
        yield* fs.writeFileString(file, row.text)
        const result = yield* reader.execute({ filePath: file }, ctx)
        expect(yield* Artifact.current(result.metadata.rayaRevision)).toBe(true)
        const history = yield* MessageV2.toModelMessagesEffect(
          [
            {
              info: {
                id: ctx.messageID,
                sessionID: ctx.sessionID,
                role: "assistant",
                parentID: MessageID.make("msg_format_user"),
                time: { created: 0 },
                modelID: model.id,
                providerID: model.providerID,
                agent: "code",
                mode: "code",
                path: { cwd: instance.directory, root: instance.directory },
                cost: 0,
                tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              },
              parts: [
                {
                  id: PartID.make("prt_format_read"),
                  messageID: ctx.messageID,
                  sessionID: ctx.sessionID,
                  type: "tool",
                  callID: ctx.callID,
                  tool: "read",
                  state: {
                    status: "completed",
                    input: { filePath: file },
                    output: result.output,
                    title: result.title,
                    metadata: result.metadata,
                    time: { start: 0, end: 1 },
                  },
                },
              ],
            },
          ],
          model,
        )
        const output = history.find((message) => message.role === "tool")
        expect(output?.content).toEqual([
          {
            type: "tool-result",
            toolCallId: ctx.callID,
            toolName: "read",
            output: { type: "text", value: result.output },
          },
        ])
        expect(result.output).toContain(
          `<file-format encoding="UTF-8" bom="${row.bom}" line-endings="${row.endings}" final-newline="${row.newline}" bytes="${Buffer.byteLength(row.text)}" sha256="${createHash("sha256").update(row.text).digest("hex")}" />`,
        )
      }
    }),
  30_000,
)

it.live("bound reads with invalid UTF-8 or binary bytes retain revision without claiming text format", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    for (const [index, bytes] of [
      Buffer.from([0xc3, 0x28]),
      Buffer.from([0xff, 0xfe, 0x61, 0]),
      Buffer.from([97, 0, 98]),
    ].entries()) {
      const file = path.join(directory, `unsupported-${index}.txt`)
      yield* Effect.promise(() => Bun.write(file, bytes))
      const info = yield* KiloReadObject.file(file)
      const result = yield* KiloReadObject.use(info, (bound) =>
        read(fs, bound, Effect.succeed({ output: "display", metadata: { display: { type: "file" } } })),
      )
      expect(result.metadata.rayaRevision.status).toBe("captured")
      expect(result.output).toBe("display")
    }
  }),
)
