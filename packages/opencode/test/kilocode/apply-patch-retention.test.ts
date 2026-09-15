import { createHash } from "node:crypto"
import path from "node:path"
import { expect, test } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Exit, Schema } from "effect"
import { Git } from "@/git"
import { cleanup, Intent as IntentSchema, records, seal, type Intent } from "@/kilocode/tool/apply-patch-receipt"
import { journals } from "@/kilocode/tool/mutation-journal"
import { Storage } from "@/storage/storage"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const hash = (value: string) => createHash("sha256").update(value).digest("hex")

test("Apply Patch intent retains every file operation", () => {
  const types = ["add", "update", "delete", "move"] as const
  const value = {
    ...draft("ses_schema", "call_schema", "C:\\workspace"),
    files: types.map((type) => ({
      filePath: `${type}.txt`,
      relativePath: `${type}.txt`,
      type,
      patch: type,
      additions: 0,
      deletions: 0,
    })),
    changes: types.map((type) => ({ filePath: `${type}.txt`, type })),
  }
  const decoded = Schema.decodeUnknownSync(IntentSchema)(value)
  expect(decoded.files.map((file) => file.type)).toEqual(types)
  expect(decoded.changes.map((change) => change.type)).toEqual(types)
})

function draft(owner: string, id: string, root: string) {
  const value: Omit<Intent, "digest"> = {
    version: 1,
    invocation: JSON.stringify([owner, "msg_test", id, root]),
    request: hash(`request:${id}`),
    workspace: root,
    diff: `diff:${id}`,
    files: [],
    changes: [],
  }
  return { ...value, digest: seal(value) }
}

function plan(root: string, invocation: string, digest: string) {
  const target = path.join(root, `${hash(invocation)}.txt`)
  const id = hash(invocation)
  return {
    invocation,
    digest,
    workspace: root,
    entries: [
      {
        kind: "replace" as const,
        target,
        stage: path.join(root, `.raya-txn-${id}.stage`),
        hold: path.join(root, `.raya-txn-${id}.hold`),
        review: { identity: { dev: "1", ino: "2" }, sha256: hash("before") },
        result: { sha256: hash("after") },
      },
    ],
  }
}

const terminal = Effect.fn("ApplyPatchRetention.terminal")(function* (
  storage: Storage.Interface,
  root: string,
  value: Intent,
) {
  const journal = journals(storage)
  const admitted = yield* journal.admit(plan(root, value.invocation, value.digest))
  if (!admitted.owned) return yield* Effect.dieMessage("test transaction was not admitted")
  const token = admitted.token
  const artifact = { identity: { dev: "3", ino: "4" }, sha256: hash("after") }
  const entries = admitted.outcome.entries.map((entry) => ({ ...entry, artifact }))
  const steps = [
    { phase: "prepared" as const, cursor: 1, entries },
    { phase: "committing" as const, cursor: 0 },
    { phase: "committing" as const, cursor: 1 },
    { phase: "committed" as const, cursor: 1 },
    { phase: "cleaning" as const, cursor: 0 },
    { phase: "cleaning" as const, cursor: 1 },
    { phase: "releasing" as const, cursor: 1 },
    { phase: "done" as const, cursor: 1 },
  ]
  let revision = admitted.outcome.revision
  for (const step of steps) {
    const outcome = yield* journal.advance(value.invocation, { token, revision, ...step })
    revision = outcome.revision
  }
  return yield* Effect.void
})

it.live("deleting a session removes only its terminal Apply Patch replay history", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const owned = draft("ses_owned", "call_owned", root)
      const other = draft("ses_other", "call_other", root)
      for (const [owner, value] of [
        ["ses_owned", owned],
        ["ses_other", other],
      ] as const) {
        yield* records(storage).prepare(owner, value)
        yield* terminal(storage, root, value)
        yield* records(storage).publish({
          version: 1,
          invocation: value.invocation,
          request: value.request,
          digest: value.digest,
          result: { title: owner, output: owner, metadata: {} },
        })
      }

      yield* cleanup(storage, "ses_owned")
      expect(yield* records(storage).getIntent(owned.invocation)).toBeUndefined()
      expect(yield* records(storage).getReceipt(owned.invocation)).toBeUndefined()
      expect(yield* journals(storage).get(owned.invocation)).toBeUndefined()
      expect(yield* records(storage).getIntent(other.invocation)).toEqual(other)
      expect((yield* records(storage).getReceipt(other.invocation))?.result.output).toBe("ses_other")
      expect((yield* journals(storage).get(other.invocation))?.phase).toBe("done")
      yield* cleanup(storage, "ses_owned")
    }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
  }),
)

it.live("cleanup refuses active or malformed session state before erasing valid evidence", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const value = draft("ses_live", "call_live", root)
      yield* records(storage).prepare("ses_live", value)
      yield* journals(storage).admit(plan(root, value.invocation, value.digest))
      expect(Exit.isFailure(yield* cleanup(storage, "ses_live").pipe(Effect.exit))).toBe(true)
      expect(yield* records(storage).getIntent(value.invocation)).toEqual(value)
      expect((yield* journals(storage).get(value.invocation))?.phase).toBe("staging")

      const owner = "ses_malformed"
      const valid = draft(owner, "call_valid", root)
      yield* records(storage).prepare(owner, valid)
      yield* storage.create(["raya", "apply-patch-sessions", hash(owner), "foreign"], {
        version: 1,
        session: owner,
        invocation: "different",
      })
      expect(Exit.isFailure(yield* cleanup(storage, owner).pipe(Effect.exit))).toBe(true)
      expect(yield* records(storage).getIntent(valid.invocation)).toEqual(valid)

      const broken = draft("ses_broken", "call_broken", root)
      yield* records(storage).prepare("ses_broken", broken)
      yield* terminal(storage, root, broken)
      yield* storage.create(["raya", "file-transactions", hash(broken.invocation), "bad"], { foreign: true })
      expect(Exit.isFailure(yield* cleanup(storage, "ses_broken").pipe(Effect.exit))).toBe(true)
      expect(yield* records(storage).getIntent(broken.invocation)).toEqual(broken)

      const capped = draft("ses_capped", "call_capped", root)
      const full: Storage.Interface = {
        ...storage,
        list: (key) =>
          key[1] === "apply-patch-sessions"
            ? Effect.succeed(Array.from({ length: 4_097 }, (_, index) => [...key, String(index)]))
            : storage.list(key),
      }
      expect(Exit.isFailure(yield* records(full).prepare("ses_capped", capped).pipe(Effect.exit))).toBe(true)
      expect(yield* records(storage).getIntent(capped.invocation)).toBeUndefined()
      expect(yield* storage.list(["raya", "apply-patch-sessions", hash("ses_capped")])).toHaveLength(0)
    }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
  }),
)
