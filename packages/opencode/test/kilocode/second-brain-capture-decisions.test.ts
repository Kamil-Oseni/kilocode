import { expect } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { Effect, Exit } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { retain } from "@/kilocode/second-brain/capture-decisions"
import { decisions } from "@/kilocode/second-brain/capture-extraction"
import { digest, identity } from "@/kilocode/second-brain/capture-source"
import { stage } from "@/kilocode/second-brain/capture-phase"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const observed = "2026-10-14T20:00:00.000Z"
const grant = "00000000-0000-4000-8000-000000000001"
const source = {
  user: {
    id: "msg_user",
    text: "My stated voice preference is uninterrupted turn-taking. I prefer quiet replies. Please just acknowledge that in one sentence.",
  },
  assistant: { id: "msg_assistant", text: "Assistant acknowledgement must not appear in a decision receipt." },
  tools: [],
}
const entry = {
  category: "Preferences",
  key: "turns",
  text: "Model summary must not appear in a decision receipt.",
  origin: "user_statement",
  evidence: [{ ref: 0 }],
}
const excluded = { status: "excluded", reason: "no_durable_fact" }
const output = { entries: [], preferences: { preference_0: { status: "retained", entry }, preference_2: excluded } }
function binding(project: string) {
  return {
    id: identity(project, "ses_capture", source.assistant.id),
    grantSHA: createHash("sha256").update(grant).digest("hex"),
    project,
    session: "ses_capture",
    assistant: source.assistant.id,
    user: source.user.id,
    source_sha256: digest(observed, source),
    model: "qwen-local/qwen3.5-4b-pinned:2a654d98e6fb",
  }
}

it.live("actual immutable Storage retains only validated exclusion or retained decisions before capture dispatch", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    for (const [index, value] of [
      { entries: [], preferences: { preference_0: excluded, preference_2: excluded } },
      output,
    ].entries()) {
      const dir = path.join(root, String(index), "storage")
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const cfg = binding(path.join(root, String(index)))
        const events: string[] = []
        yield* stage(
          retain(
            cfg,
            value,
            source,
            observed,
            Effect.succeed({ source_sha256: digest(observed, source) }),
            Date.now() + 30000,
            true,
          ),
          () => Effect.sync(() => events.push("captureFailed")),
          (rows) =>
            Effect.gen(function* () {
              const saved = yield* storage.readBounded(["raya", "capture-decisions", cfg.id], 16384)
              expect(saved).toEqual({
                format: "raya.capture.decisions",
                version: 1,
                ...cfg,
                count: index,
                decisions: [
                  index
                    ? { slot: "preference_0", ref: 0, status: "retained" }
                    : { slot: "preference_0", ref: 0, ...excluded },
                  { slot: "preference_2", ref: 2, ...excluded },
                ],
                scope: "preparation_observation_only",
                publication: false,
                indexConfirmed: false,
                replay: false,
              })
              expect(rows).toHaveLength(index)
              events.push("capture")
            }),
        )
        expect(events).toEqual(["capture"])
        const raw = yield* fs.readFileString(path.join(dir, "raya", "capture-decisions", `${cfg.id}.json`))
        for (const text of [source.user.text, source.assistant.text, entry.text, grant]) expect(raw).not.toContain(text)
        expect(() => JSON.parse(raw)).not.toThrow()
      }).pipe(Effect.provide(Storage.layerFromDir(dir)))
    }
  }),
)

it.live("missing and invalid decisions or bindings fail before dispatch and create no receipt", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const cfg = binding(root)
      for (const value of [
        { entries: [] },
        {
          ...output,
          preferences: { preference_0: { status: "excluded", reason: "invented" }, preference_2: excluded },
        },
        {
          ...output,
          preferences: {
            preference_0: { status: "retained", entry: { ...entry, evidence: [{ ref: 4 }] } },
            preference_2: excluded,
          },
        },
        { ...output, rawModelText: "do not retain" },
      ]) {
        const events: string[] = []
        const result = yield* stage(
          retain(
            cfg,
            value,
            source,
            observed,
            Effect.succeed({ source_sha256: digest(observed, source) }),
            Date.now() + 30000,
            true,
          ),
          () => Effect.sync(() => events.push("captureFailed")),
          () => Effect.sync(() => events.push("capture")),
        ).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(events).toEqual(["captureFailed"])
        expect(yield* storage.list(["raya", "capture-decisions"])).toEqual([])
      }
      for (const input of [
        { ...cfg, model: "" },
        { ...cfg, model: "missing-slash" },
        { ...cfg, model: "/missing-provider" },
        { ...cfg, model: "missing-model/" },
        { ...cfg, model: "provider/" + "x".repeat(505) },
        { ...cfg, grantSHA: undefined },
        { ...cfg, user: "msg_foreign" },
        { ...cfg, source_sha256: "a".repeat(64) },
        { ...cfg, rawSource: source.user.text },
      ]) {
        expect(
          Exit.isFailure(
            yield* retain(
              input,
              output,
              source,
              observed,
              Effect.succeed({ source_sha256: digest(observed, source) }),
              Date.now() + 30000,
              true,
            ).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(yield* storage.list(["raya", "capture-decisions"])).toEqual([])
      }
      expect(() => decisions({ entries: [] }, source, true)).toThrow("bounded entry schema")
    }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
  }),
)

it.live("an existing decision receipt never authorizes another dispatch or changes original bytes", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    const dir = path.join(root, "storage")
    yield* Effect.gen(function* () {
      const cfg = binding(root)
      yield* retain(
        cfg,
        output,
        source,
        observed,
        Effect.succeed({ source_sha256: digest(observed, source) }),
        Date.now() + 30000,
        true,
      )
      const file = path.join(dir, "raya", "capture-decisions", `${cfg.id}.json`)
      const before = yield* fs.readFileString(file)
      const events: string[] = []
      const result = yield* stage(
        retain(
          cfg,
          output,
          source,
          observed,
          Effect.succeed({ source_sha256: digest(observed, source) }),
          Date.now() + 30000,
          true,
        ),
        () => Effect.sync(() => events.push("captureFailed")),
        () => Effect.sync(() => events.push("capture")),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(events).toEqual(["captureFailed"])
      expect(yield* fs.readFileString(file)).toBe(before)
    }).pipe(Effect.provide(Storage.layerFromDir(dir)))
  }),
)

it.live("actual filesystem retention failure propagates through the pre-dispatch stage", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    const dir = path.join(root, "storage")
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      yield* storage.list(["raya", "capture-decisions"])
      const blocked = path.join(dir, "raya", "capture-decisions")
      yield* fs.writeWithDirs(blocked, "original blocking file")
      const events: string[] = []
      const result = yield* stage(
        retain(
          binding(root),
          output,
          source,
          observed,
          Effect.succeed({ source_sha256: digest(observed, source) }),
          Date.now() + 30000,
          true,
        ),
        () => Effect.sync(() => events.push("captureFailed")),
        () => Effect.sync(() => events.push("capture")),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(events).toEqual(["captureFailed"])
      expect(yield* fs.readFileString(blocked)).toBe("original blocking file")
    }).pipe(Effect.provide(Storage.layerFromDir(dir)))
  }),
)

it.live("decision receipts accept the same bounded model identifiers as Memory configuration", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      for (const [index, model] of ["local/model+variant", "_provider/model", "provider/team/nested/model"].entries()) {
        const cfg = { ...binding(path.join(root, String(index))), model }
        yield* retain(
          cfg,
          output,
          source,
          observed,
          Effect.succeed({ source_sha256: cfg.source_sha256 }),
          Date.now() + 30000,
          true,
        )
        expect(yield* storage.readBounded(["raya", "capture-decisions", cfg.id], 16384)).toMatchObject({ model })
      }
    }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
  }),
)
