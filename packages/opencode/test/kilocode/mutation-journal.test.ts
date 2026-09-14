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

function batch(root: string, invocation: string, targets: string[]) {
  return {
    ...plan(root, invocation, targets[0]),
    entries: targets.map((target, index) => plan(root, `${invocation}-${index}`, target).entries[0]),
  }
}

function service<A, E>(dir: string, run: (storage: Storage.Interface) => Effect.Effect<A, E>) {
  return Effect.gen(function* () {
    return yield* run(yield* Storage.Service)
  }).pipe(Effect.provide(Storage.layerFromDir(dir)))
}

function instance<A, E>(dir: string, run: (journal: ReturnType<typeof journals>) => Effect.Effect<A, E>) {
  return service(dir, (storage) => run(journals(storage)))
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
    const releasing = yield* instance(dir, (journal) =>
      journal.advance(input.invocation, {
        token: owned.token,
        revision: cleaned.revision,
        phase: "releasing",
        cursor: input.entries.length,
      }),
    )
    const done = yield* instance(dir, (journal) =>
      journal.advance(input.invocation, {
        token: owned.token,
        revision: releasing.revision,
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

it.live("recovers a reservation interrupted during target claim acquisition", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const dir = path.join(root, "storage")
    const targets = [path.join(root, "a.txt"), path.join(root, "b.txt")]
    const input = batch(root, "partial-claims", targets)
    const calls = { value: 0 }
    const interrupted = yield* service(dir, (storage) =>
      journals({
        ...storage,
        create: (key, content) => {
          calls.value++
          if (calls.value === 3) return Effect.die("simulated admission crash")
          return storage.create(key, content)
        },
      })
        .admit(input)
        .pipe(Effect.exit),
    )
    expect(Exit.isFailure(interrupted)).toBe(true)
    expect((yield* instance(dir, (journal) => journal.get(input.invocation)))?.phase).toBe("reserved")
    const recovered = yield* instance(dir, (journal) => journal.recover(input.invocation, () => Effect.succeed(true)))
    expect(recovered.owned).toBe(true)
    if (!recovered.owned) return
    const rolling = yield* instance(dir, (journal) =>
      journal.advance(input.invocation, {
        token: recovered.token,
        revision: recovered.outcome.revision,
        phase: "rolling_back",
        cursor: 0,
      }),
    )
    const rolled = yield* instance(dir, (journal) =>
      journal.advance(input.invocation, {
        token: recovered.token,
        revision: rolling.revision,
        phase: "rolled_back",
        cursor: input.entries.length,
      }),
    )
    const cleaning = yield* instance(dir, (journal) =>
      journal.advance(input.invocation, {
        token: recovered.token,
        revision: rolled.revision,
        phase: "cleaning",
        cursor: 0,
      }),
    )
    const cleaned = yield* instance(dir, (journal) =>
      journal.advance(input.invocation, {
        token: recovered.token,
        revision: cleaning.revision,
        phase: "cleaning",
        cursor: input.entries.length,
      }),
    )
    const releasing = yield* instance(dir, (journal) =>
      journal.advance(input.invocation, {
        token: recovered.token,
        revision: cleaned.revision,
        phase: "releasing",
        cursor: input.entries.length,
      }),
    )
    const done = yield* instance(dir, (journal) =>
      journal.advance(input.invocation, {
        token: recovered.token,
        revision: releasing.revision,
        phase: "done",
        cursor: input.entries.length,
      }),
    )
    expect(done.phase).toBe("done")
    const reuse = yield* Effect.all(
      targets.map((target, index) => instance(dir, (journal) => journal.admit(plan(root, `reuse-${index}`, target)))),
      { concurrency: 2 },
    )
    expect(reuse.every((row) => row.owned)).toBe(true)
  }),
)

it.live("releases partial claims when recovery finds a competing transaction", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const dir = path.join(root, "storage")
    const first = path.join(root, "a.txt")
    const second = path.join(root, "b.txt")
    const input = batch(root, "partial-conflict", [first, second])
    const calls = { value: 0 }
    yield* service(dir, (storage) =>
      journals({
        ...storage,
        create: (key, content) => {
          calls.value++
          if (calls.value === 3) return Effect.die("simulated admission crash")
          return storage.create(key, content)
        },
      })
        .admit(input)
        .pipe(Effect.exit),
    )
    const blocker = yield* instance(dir, (journal) => journal.admit(plan(root, "blocker", second)))
    expect(blocker.owned).toBe(true)
    const recovered = yield* instance(dir, (journal) => journal.recover(input.invocation, () => Effect.succeed(true)))
    expect(recovered.owned).toBe(false)
    expect(recovered.outcome?.phase).toBe("conflict")
    expect((yield* instance(dir, (journal) => journal.admit(plan(root, "released", first)))).owned).toBe(true)
    expect((yield* instance(dir, (journal) => journal.admit(plan(root, "still-blocked", second)))).owned).toBe(false)
  }),
)

it.live("recovers when completion is interrupted during claim release", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const dir = path.join(root, "storage")
    const targets = [path.join(root, "a.txt"), path.join(root, "b.txt")]
    const input = batch(root, "partial-release", targets)
    const admitted = yield* instance(dir, (journal) => journal.admit(input))
    expect(admitted.owned).toBe(true)
    if (!admitted.owned) return
    const entries = input.entries.map((entry) => ({ ...entry, artifact: proof }))
    const step = (revision: number, phase: "prepared" | "committing" | "committed" | "cleaning", cursor: number) =>
      instance(dir, (journal) =>
        journal.advance(input.invocation, { token: admitted.token, revision, phase, cursor, entries }),
      )
    const prepared = yield* step(admitted.outcome.revision, "prepared", entries.length)
    const committing = yield* step(prepared.revision, "committing", 0)
    const published = yield* step(committing.revision, "committing", entries.length)
    const committed = yield* step(published.revision, "committed", entries.length)
    const cleaning = yield* step(committed.revision, "cleaning", 0)
    const cleaned = yield* step(cleaning.revision, "cleaning", entries.length)
    const calls = { value: 0 }
    const interrupted = yield* service(dir, (storage) =>
      journals({
        ...storage,
        remove: (key) => {
          calls.value++
          if (calls.value === 2) return Effect.die("simulated release crash")
          return storage.remove(key)
        },
      })
        .advance(input.invocation, {
          token: admitted.token,
          revision: cleaned.revision,
          phase: "releasing",
          cursor: entries.length,
          entries,
        })
        .pipe(Effect.exit),
    )
    expect(Exit.isFailure(interrupted)).toBe(true)
    expect((yield* instance(dir, (journal) => journal.get(input.invocation)))?.phase).toBe("releasing")
    const successor = yield* instance(dir, (journal) => journal.admit(plan(root, "successor", targets[0])))
    expect(successor.owned).toBe(true)
    const recovered = yield* instance(dir, (journal) => journal.recover(input.invocation, () => Effect.succeed(true)))
    expect(recovered.owned).toBe(true)
    if (!recovered.owned) return
    const done = yield* instance(dir, (journal) =>
      journal.advance(input.invocation, {
        token: recovered.token,
        revision: recovered.outcome.revision,
        phase: "done",
        cursor: entries.length,
        entries,
      }),
    )
    expect(done.phase).toBe("done")
    expect((yield* instance(dir, (journal) => journal.admit(plan(root, "released", targets[1])))).owned).toBe(true)
    expect((yield* instance(dir, (journal) => journal.admit(plan(root, "protected", targets[0])))).owned).toBe(false)
  }),
)
