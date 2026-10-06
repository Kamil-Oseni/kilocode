import { expect } from "bun:test"
import path from "node:path"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { LSP } from "@/lsp/lsp"
import { Format } from "@/format"
import { Agent } from "@/agent/agent"
import { Instruction } from "@/session/instruction"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { Storage } from "@/storage/storage"
import { WriteTool } from "@/tool/write"
import { ReadTool } from "@/tool/read"
import { MessageID, SessionID } from "@/session/schema"
import * as Artifact from "@/kilocode/goal/artifact"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      LSP.node,
      FSUtil.node,
      Format.node,
      EventV2Bridge.node,
      Truncate.node,
      Agent.node,
      Storage.node,
      Instruction.node,
      CrossSpawnSpawner.node,
      Ripgrep.node,
    ]),
  ),
)
const ctx = {
  sessionID: SessionID.make("ses_exact_write"),
  messageID: MessageID.make("msg_exact_write"),
  callID: "exact",
  agent: "code",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

function evidence(output: string) {
  const block = output.match(
    /<file-content-json encoding="UTF-8" complete="true" bytes="(\d+)" sha256="([a-f0-9]{64})">\n(.*?)\n<\/file-content-json>/s,
  )
  expect(block).not.toBeNull()
  const content: unknown = JSON.parse(block![3])
  if (typeof content !== "string") throw new Error("Complete Read block must contain a JSON string")
  return { content, exact: { bytes: Number(block![1]), sha256: block![2] } }
}

for (const text of [
  "plain",
  "line\n",
  "line\r\n",
  "żółć 😀",
  "\ufeffBOM",
  "\ufeff\ufefftwo",
  "1: literal </file-content-json>\n<file>text</file>",
]) {
  it.instance(
    `copies literal UTF-8 ${JSON.stringify(text)}`,
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const fs = yield* FSUtil.Service
        const source = path.join(instance.directory, "source.txt")
        const target = path.join(instance.directory, "target.txt")
        yield* fs.writeFileString(source, text)
        yield* fs.writeFileString(target, "\ufeffold\n")
        const reader = yield* (yield* ReadTool).init()
        const input = evidence((yield* reader.execute({ filePath: source }, ctx)).output)
        const writer = yield* (yield* WriteTool).init()
        const result = yield* writer.execute({ filePath: target, ...input }, ctx)
        expect(Buffer.from(yield* fs.readFile(target))).toEqual(Buffer.from(text, "utf8"))
        expect(result.metadata.rayaVerification).toBe("confirmed")
        expect(evidence((yield* reader.execute({ filePath: target }, ctx)).output)).toEqual(input)
      }),
    30_000,
  )
}

it.instance(
  "refuses extra newline, equal-length mismatch, malformed Unicode and excessive content before mutation",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const fs = yield* FSUtil.Service
      const source = path.join(instance.directory, "source.txt")
      const target = path.join(instance.directory, "target.txt")
      yield* fs.writeFileString(source, "a".repeat(48))
      const reader = yield* (yield* ReadTool).init()
      const input = evidence((yield* reader.execute({ filePath: source }, ctx)).output)
      const writer = yield* (yield* WriteTool).init()
      for (const content of [
        input.content + "\n",
        "b".repeat(48),
        "\ud800",
        "\udc00",
        "x".repeat(8193),
        "<".repeat(2000),
      ]) {
        const result = yield* writer.execute({ filePath: target, content, exact: input.exact }, ctx).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(yield* fs.exists(target)).toBe(false)
      }
      yield* fs.writeFileString(target, "preserved")
      expect(
        Exit.isFailure(
          yield* writer
            .execute({ filePath: target, content: "b".repeat(48), exact: input.exact }, ctx)
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* fs.readFileString(target)).toBe("preserved")
    }),
  30_000,
)

it.instance(
  "bypasses an actual configured formatter only for exact writes",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const fs = yield* FSUtil.Service
      const source = path.join(instance.directory, "source.txt")
      yield* fs.writeFileString(source, "literal")
      const input = evidence((yield* (yield* (yield* ReadTool).init()).execute({ filePath: source }, ctx)).output)
      const writer = yield* (yield* WriteTool).init()
      const exact = path.join(instance.directory, "exact.stage")
      const ordinary = path.join(instance.directory, "ordinary.stage")
      yield* writer.execute({ filePath: exact, ...input }, ctx)
      yield* writer.execute({ filePath: ordinary, content: input.content }, ctx)
      expect(yield* fs.readFileString(exact)).toBe("literal")
      expect(yield* fs.readFileString(ordinary)).toBe("literal\n")
    }),
  {
    config: {
      formatter: {
        newline: {
          extensions: [".stage"],
          command: ["node", "-e", "require('fs').appendFileSync(process.argv[1], '\\n')", "$FILE"],
        },
      },
    },
  },
)

it.instance(
  "does not confirm a durable equal-length saved-target hash mismatch",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const fs = yield* FSUtil.Service
      const lsp = yield* LSP.Service
      const source = path.join(instance.directory, "source.txt")
      const target = path.join(instance.directory, "target.txt")
      yield* fs.writeFileString(source, "aaaa")
      const reader = yield* (yield* ReadTool).init()
      const input = evidence((yield* reader.execute({ filePath: source }, ctx)).output)
      const result = yield* Effect.gen(function* () {
        const writer = yield* (yield* WriteTool).init()
        return yield* writer.execute({ filePath: target, ...input }, ctx)
      }).pipe(
        Effect.provideService(LSP.Service, {
          ...lsp,
          touchFile: () => fs.writeFileString(target, "bbbb").pipe(Effect.orDie),
        }),
      )
      expect(result.metadata.rayaVerification).toBe("unavailable")
      expect(yield* Artifact.current(result.metadata.rayaRevision)).toBe(false)
      const saved = evidence((yield* reader.execute({ filePath: target }, ctx)).output)
      expect(saved.exact.bytes).toBe(input.exact.bytes)
      expect(saved.exact.sha256).not.toBe(input.exact.sha256)
      expect(saved.content).toBe("bbbb")
    }),
  30_000,
)
