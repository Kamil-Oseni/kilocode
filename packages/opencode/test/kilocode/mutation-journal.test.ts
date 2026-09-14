import { createHash } from "node:crypto"
import path from "node:path"
import { expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Exit } from "effect"
import { Git } from "@/git"
import { journals } from "@/kilocode/tool/mutation-journal"
import { Storage } from "@/storage/storage"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const proof = { identity: { dev: "1", ino: "2" }, sha256: hash("before") }

function plan(root: string, invocation: string, target = path.join(root, "value.txt")) {
  return {
    invocation,
    digest: hash(`patch:${invocation}`),
    workspace: root,
    entries: [
      {
        kind: "replace" as const,
        target,
        stage: path.join(path.dirname(target), `.raya-txn-${invocation}.stage`),
        hold: path.join(path.dirname(target), `.raya-txn-${invocation}.hold`),
        review: proof,
        result: { sha256: hash("after") },
      },
    ],
  }
}

function instance<A, E>(dir: string, run: (journal: ReturnType<typeof journals>) => Effect.Effect<A, E>) {
  return Effect.gen(function* () {
    return yield* run(journals(yield* Storage.Service))
  }).pipe(Effect.provide(Storage.layerFromDir(dir)))
}

it.live("grants one durable owner across independent storage instances", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const dir = path.join(root, "storage")
    const input = plan(root, "same-invocation")
    const rows = yield* Effect.all(
      Array.from({ length: 8 }, () => instance(dir, (journal) => journal.admit(input).pipe(Effect.exit))),
      { concurrency: 8 },
    )
    const success = rows.filter(Exit.isSuccess).map((exit) => exit.value)
    expect(success.filter((row) => row.owned)).toHaveLength(1)
    expect(success.filter((row) => row.owned && row.token)).toHaveLength(1)
    expect(success.every((row) => row.outcome.id === success[0]!.outcome.id)).toBe(true)
    expect((yield* instance(dir, (journal) => journal.get(input.invocation)))?.phase).toBe("staging")
  }),
)

it.live("allows only one transaction to own the same canonical target", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const dir = path.join(root, "storage")
    const target = path.join(root, "shared.txt")
    const rows = yield* Effect.all(
      ["first", "second"].map((id) => instance(dir, (journal) => journal.admit(plan(root, id, target)))),
      { concurrency: 2 },
    )
    expect(rows.filter((row) => row.owned)).toHaveLength(1)
    expect(rows.filter((row) => row.outcome.phase === "conflict")).toHaveLength(1)
  }),
)

it.live("retains immutable phases across restart and rejects stale or forged advancement", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const dir = path.join(root, "storage")
    const input = plan(root, "restart")
    const admitted = yield* instance(dir, (journal) => journal.admit(input))
    expect(admitted.owned).toBe(true)
    if (!admitted.owned) return
    const prepared = yield* instance(dir, (journal) =>
      journal.advance(input.invocation, {
        token: admitted.token,
        revision: 1,
        phase: "prepared",
        cursor: 1,
        entries: input.entries.map((entry) => ({ ...entry, artifact: proof })),
      }),
    )
    expect(prepared.phase).toBe("prepared")
    expect((yield* instance(dir, (journal) => journal.get(input.invocation)))?.entries[0]?.artifact).toEqual(proof)
    expect(
      Exit.isFailure(
        yield* instance(dir, (journal) =>
          journal
            .advance(input.invocation, {
              token: "wrong",
              revision: 2,
              phase: "committing",
              cursor: 1,
            })
            .pipe(Effect.exit),
        ),
      ),
    ).toBe(true)
    const attempts = yield* Effect.all(
      Array.from({ length: 6 }, () =>
        instance(dir, (journal) =>
          journal
            .advance(input.invocation, {
              token: admitted.token,
              revision: 2,
              phase: "committing",
              cursor: 1,
            })
            .pipe(Effect.exit),
        ),
      ),
      { concurrency: 6 },
    )
    expect(attempts.filter(Exit.isSuccess)).toHaveLength(1)
  }),
)

it.live("rejects a changed request digest and ambiguous transaction plans", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const dir = path.join(root, "storage")
    const input = plan(root, "bound")
    yield* instance(dir, (journal) => journal.admit(input))
    expect(
      Exit.isFailure(
        yield* instance(dir, (journal) => journal.admit({ ...input, digest: hash("different") }).pipe(Effect.exit)),
      ),
    ).toBe(true)
    expect(
      Exit.isFailure(
        yield* instance(dir, (journal) =>
          journal
            .admit({ ...plan(root, "duplicate"), entries: [input.entries[0]!, input.entries[0]!] })
            .pipe(Effect.exit),
        ),
      ),
    ).toBe(true)
  }),
)

it.live("fences competing recovery owners and lets one adopted owner finish", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const dir = path.join(root, "storage")
    const input = plan(root, "recovery")
    yield* instance(dir, (journal) => journal.admit(input))
    const rows = yield* Effect.all(
      Array.from({ length: 8 }, () =>
        instance(dir, (journal) => journal.recover(input.invocation, () => Effect.succeed(true))),
      ),
      { concurrency: 8 },
    )
    expect(rows.filter((row) => row.owned)).toHaveLength(1)
    const owned = rows.find((row) => row.owned)
    if (!owned?.owned) return
    const rolling = yield* instance(dir, (journal) =>
      journal.advance(input.invocation, {
        token: owned.token,
        revision: owned.outcome.revision,
        phase: "rolling_back",
        cursor: 0,
      }),
    )
    const rolled = yield* instance(dir, (journal) =>
      journal.advance(input.invocation, {
        token: owned.token,
        revision: rolling.revision,
        phase: "rolled_back",
        cursor: input.entries.length,
      }),
    )
    const cleaning = yield* instance(dir, (journal) =>
      journal.advance(input.invocation, {
        token: owned.token,
        revision: rolled.revision,
        phase: "cleaning",
        cursor: 0,
      }),
    )
    const cleaned = yield* instance(dir, (journal) =>
      journal.advance(input.invocation, {
        token: owned.token,
        revision: cleaning.revision,
        phase: "cleaning",
        cursor: input.entries.length,
      }),
    )
    const done = yield* instance(dir, (journal) =>
      journal.advance(input.invocation, {
        token: owned.token,
        revision: cleaned.revision,
        phase: "done",
        cursor: input.entries.length,
      }),
    )
    expect(done.decision).toBe("rollback")
    expect(
      (yield* instance(dir, (journal) => journal.recover(input.invocation, () => Effect.succeed(true)))).owned,
    ).toBe(false)
  }),
)
