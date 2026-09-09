import { expect } from "bun:test"
import path from "node:path"
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
import { MessageID, SessionID } from "@/session/schema"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

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
            return { output: bytes.toString(), metadata: { truncated: false } }
          }),
        ),
      )
      expect(result.output).toBe("original bytes")
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
