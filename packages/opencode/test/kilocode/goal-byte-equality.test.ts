import { expect } from "bun:test"
import path from "node:path"
import { Effect, Schema } from "effect"
import { GoalCriteria } from "@/kilocode/goal/criteria"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Storage } from "@/storage/storage"
import { Git } from "@/git"
import { RayaGoal } from "@/kilocode/goal"
import * as Artifact from "@/kilocode/goal/artifact"
import { KiloReadObject } from "@/kilocode/tool/read-object"
import { read } from "@/kilocode/goal/read-artifact"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Storage.node, FSUtil.node, CrossSpawnSpawner.node, Git.node])))

const scenario = (mode: string) =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const storage = yield* Storage.Service
    const dir = yield* tmpdirScoped()
    const source = path.join(dir, "source.txt")
    const target = path.join(dir, "target.txt")
    const content = mode === "empty" ? "" : "a".repeat(48)
    yield* fs.writeFileString(source, content)
    yield* fs.writeFileString(target, content + (mode === "newline" ? "\n" : ""))
    const baseline = yield* Artifact.capture(fs, source)
    if (baseline.status !== "captured") throw new Error("Actual source capture required")
    const sid = SessionID.make(`ses_equality_${crypto.randomUUID()}`)
    const rows: MessageV2.WithParts[] = []
    const goals = RayaGoal.make({
      storage,
      sessions: { messages: () => Effect.succeed(rows), children: () => Effect.succeed([]) },
    })
    yield* Effect.addFinalizer(() => goals.clear(sid))
    const goal = yield* goals.create(sid, "Preserve the exact source bytes")
    yield* goals.edit(sid, {
      expectedIntent: goal.intent,
      criteria: [
        {
          review: mode.startsWith("review") ? true : undefined,
          id: "bytes",
          description: "Source and target have identical original bytes",
          verification: "Compare the current raw files against the saved source",
          check: {
            kind: "byte-equality",
            source: {
              path: source,
              canonical: baseline.canonical,
              sha256: mode === "wronghash" ? "0".repeat(64) : baseline.sha256,
              bytes: content.length + (mode === "wrongbytes" ? 1 : 0),
            },
            target: { path: target, canonical: mode === "canonical" ? source : target },
          },
        },
        ...(mode === "broader"
          ? [{ id: "other", description: "Another required result", verification: "Verify other work" }]
          : []),
      ],
    })
    if (mode === "bothchanged") {
      yield* fs.writeFileString(source, "different")
      yield* fs.writeFileString(target, "different")
    }
    const other = path.join(dir, "other.txt")
    if (mode === "foreign") yield* fs.writeFileString(other, content)
    const user: MessageV2.User = {
      id: MessageID.ascending(),
      sessionID: sid,
      role: "user",
      time: { created: Date.now() },
      agent: "code",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
    }
    const assistant: MessageV2.Assistant = {
      id: MessageID.ascending(),
      parentID: user.id,
      sessionID: sid,
      role: "assistant",
      time: { created: Date.now(), completed: Date.now() },
      agent: "code",
      mode: "code",
      path: { cwd: dir, root: dir },
      providerID: user.model.providerID,
      modelID: user.model.modelID,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    }
    const parts: MessageV2.ToolPart[] = []
    rows.push({ info: user, parts: [] }, { info: assistant, parts })
    for (const file of [source, mode === "foreign" ? other : target]) {
      const object = yield* KiloReadObject.file(file)
      const result = yield* KiloReadObject.use(object, (bound) =>
        read(fs, bound, Effect.succeed({ metadata: {}, output: "inspected" })),
      )
      parts.push({
        id: PartID.ascending(),
        sessionID: sid,
        messageID: assistant.id,
        type: "tool",
        tool: "read",
        callID: crypto.randomUUID(),
        state: {
          status: "completed",
          input: { filePath: file },
          title: "read",
          output: result.output,
          metadata: result.metadata,
          time: { start: Date.now(), end: Date.now() },
        },
      })
    }
    if (mode === "missing") parts.pop()
    if (mode === "legacy") {
      for (const part of parts) {
        if (part.state.status !== "completed") throw new Error("Completed read required")
        const revision = Artifact.entries(part.state.metadata.rayaRevision)[0]
        if (!revision || revision.status !== "captured") throw new Error("Captured read required")
        part.state.metadata.rayaRevision = {
          version: revision.version,
          status: revision.status,
          path: revision.path,
          canonical: revision.canonical,
          sha256: revision.sha256,
          mode: revision.mode,
        }
      }
    }
    if (mode === "stale") yield* fs.writeFileString(target, "later")
    if (mode === "pregoal") {
      for (const part of parts) {
        if (part.state.status !== "completed") throw new Error("Completed read required")
        part.state.time.start = goal.createdAt - 1
      }
    }
    const result = yield* goals
      .update(sid, {
        status: "complete",
        audit: {
          summary: "Exact copy complete",
          requirements: [
            {
              criterionID: "bytes",
              requirement: "Source and target have identical original bytes",
              passed: true,
              evidence: parts.map((part) => ({
                callID: part.callID,
                messageID: part.messageID,
                partID: part.id,
                sessionID: sid,
                summary: "Current file read",
              })),
            },
            ...(mode === "broader"
              ? [{ criterionID: "other", requirement: "Another required result", passed: false, evidence: [] }]
              : []),
          ],
        },
      })
      .pipe(Effect.exit)
    const accepted = mode === "equal" || mode === "empty" || mode.startsWith("review")
    expect(result._tag).toBe(accepted ? "Success" : "Failure")
    expect((yield* goals.get(sid))?.status).toBe(
      mode.startsWith("review") ? "paused" : accepted ? "complete" : "active",
    )
    expect((yield* goals.get(sid))?.auditAttempt?.accepted).toBe(accepted)
    if (mode.startsWith("review")) {
      if (mode === "reviewstale") yield* fs.writeFileString(target, "changed after review")
      const saved = yield* goals.get(sid)
      const reviewed = yield* goals.edit(sid, { accept: true, expectedIntent: saved?.intent }).pipe(Effect.exit)
      expect(reviewed._tag).toBe(mode === "reviewstale" ? "Failure" : "Success")
      expect((yield* goals.get(sid))?.status).toBe(mode === "reviewstale" ? "paused" : "complete")
    }
  })

for (const mode of [
  "newline",
  "equal",
  "empty",
  "bothchanged",
  "foreign",
  "missing",
  "legacy",
  "stale",
  "pregoal",
  "broader",
  "review",
  "reviewstale",
  "wronghash",
  "wrongbytes",
  "canonical",
]) {
  it.live(`saved byte equality checks actual current file evidence: ${mode}`, () => scenario(mode))
}

it.live("saved equality schema rejects malformed baselines while model controls cannot select checks", () =>
  Effect.gen(function* () {
    const check = {
      kind: "byte-equality",
      source: { path: process.cwd(), canonical: process.cwd(), sha256: "a".repeat(64), bytes: 0 },
      target: { path: process.cwd(), canonical: process.cwd() },
    }
    for (const bytes of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const exit = yield* Schema.decodeUnknownEffect(GoalCriteria)([
        {
          id: "bytes",
          description: "Same bytes",
          verification: "Verify",
          check: { ...check, source: { ...check.source, bytes } },
        },
      ]).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }
    for (const source of [
      { ...check.source, sha256: "wrong" },
      { ...check.source, path: "relative.txt" },
      { ...check.source, canonical: "relative.txt" },
    ]) {
      const exit = yield* Schema.decodeUnknownEffect(GoalCriteria)([
        { id: "bytes", description: "Same bytes", verification: "Verify", check: { ...check, source } },
      ]).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }
    const criteria = [{ id: "bytes", description: "Same bytes", verification: "Verify", check }]
    expect(yield* Schema.decodeUnknownEffect(RayaGoal.ModelUpdate)({ status: "active", criteria })).toEqual({
      status: "active",
    })
    expect(yield* Schema.decodeUnknownEffect(RayaGoal.Create)({ objective: "Do work", criteria })).toEqual({
      objective: "Do work",
    })
  }),
)
