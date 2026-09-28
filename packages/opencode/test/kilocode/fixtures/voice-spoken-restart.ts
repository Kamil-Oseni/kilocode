import path from "node:path"
import { eq, sql } from "drizzle-orm"
import { Effect, Exit, Scope } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { RayaVoiceBindingTable as Table } from "@opencode-ai/core/kilocode/voice.sql"
import { Git } from "../../../src/git"
import { Storage, NotFoundError } from "../../../src/storage/storage"
import { Runner } from "../../../src/effect/runner"
import { observe } from "../../../src/kilocode/effect/observation"
import * as Workers from "../../../src/kilocode/session/task-worker"
import * as Store from "../../../src/kilocode/voice/openai-store"
import { make } from "../../../src/kilocode/voice/openai"
import { MessageV2 } from "../../../src/session/message-v2"
import { SessionID } from "../../../src/session/schema"

const [mode, root] = process.argv.slice(2)
if (!mode || !root || !path.isAbsolute(root))
  throw new Error("Expected spoken fixture mode and absolute disposable root")
const parent = SessionID.make("ses_spoken_restart")
const other = SessionID.make("ses_spoken_other")
const key = "a".repeat(64)
const fresh = "b".repeat(64)
const start = { parentSessionID: parent, providerCallID: "spoken_provider_before", requestID: "spoken_before" }
const layer = LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))
const items = [
  { id: "input", previous: null, role: "user" as const, state: "final" as const, text: "I want quiet company." },
  { id: "pending", previous: "input", role: "assistant" as const, state: "pending" as const },
  { id: "tool", previous: "pending", role: "other" as const, state: "omitted" as const },
  { id: "interrupted", previous: "tool", role: "assistant" as const, state: "omitted" as const },
  {
    id: "output",
    previous: "interrupted",
    role: "assistant" as const,
    state: "final" as const,
    text: "We can take this slowly.",
  },
]
const print = (value: Record<string, unknown>) => process.stdout.write(`SPOKEN_RESULT ${JSON.stringify(value)}\n`)
const refused = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.exit, Effect.map(Exit.isFailure))

const run = Effect.gen(function* () {
  const database = yield* Database.Service
  const storage = yield* Storage.Service
  const runner = Runner.make<MessageV2.WithParts>(yield* Scope.Scope, {
    onInterrupt: Effect.die("Unexpected fixture work"),
  })
  const workers = yield* Workers.make({
    inspect: () => Effect.succeed(observe(runner)),
    requestCancel: (_, id) => runner.requestCancel(id),
  })
  const work = { count: 0 }
  const voice = yield* make({
    database,
    storage,
    workers,
    sessions: {
      get: (id: SessionID) =>
        Effect.gen(function* () {
          const row = yield* database.db
            .select()
            .from(SessionTable)
            .where(eq(SessionTable.id, id))
            .get()
            .pipe(Effect.orDie)
          if (!row) return yield* Effect.fail(new NotFoundError({ message: "Spoken fixture parent missing" }))
          return { id: SessionID.make(row.id), directory: row.directory }
        }),
    },
    prompts: {
      prompt: () =>
        Effect.sync(() => {
          work.count++
          throw new Error("Spoken recovery must never dispatch work")
        }),
    },
  })
  const admit = (input: typeof start, secret: string) =>
    Effect.gen(function* () {
      yield* voice.reserve(
        { parentSessionID: input.parentSessionID, requestID: input.requestID, model: "gpt-realtime-2.1" },
        secret,
        root,
      )
      return yield* voice.start(input, secret, root)
    })
  const store = Store.make(database, storage)
  if (mode === "seed") {
    yield* database.db
      .run(
        sql`INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES ('spoken-project',${root},1,1,'[]')`,
      )
      .pipe(Effect.orDie)
    for (const id of [parent, other])
      yield* database.db
        .run(
          sql`INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated) VALUES (${id},'spoken-project',${id},${root},'Spoken restart','test',1,1)`,
        )
        .pipe(Effect.orDie)
    const binding = yield* admit(start, key)
    const input = {
      version: 1 as const,
      revision: 1,
      generation: binding.generation,
      providerCallID: start.providerCallID,
      items: [items[4]!, items[0]!, items[2]!, items[1]!, items[3]!],
    }
    const committed = yield* voice.spoken(binding.id, input, key, root)
    const duplicate = yield* voice.spoken(binding.id, input, key, root)
    const conflict = yield* refused(
      voice.spoken(
        binding.id,
        {
          ...input,
          items: input.items.map((item) => (item.id === "input" ? { ...item, text: "Conflicting final text" } : item)),
        },
        key,
        root,
      ),
    )
    const separate = yield* admit(
      { parentSessionID: other, providerCallID: "spoken_provider_other", requestID: "spoken_other" },
      "c".repeat(64),
    )
    yield* voice.spoken(
      separate.id,
      {
        version: 1,
        revision: 1,
        generation: separate.generation,
        providerCallID: separate.providerCallID,
        items: [{ id: "other-input", previous: null, role: "user", state: "final", text: "Other task secret" }],
      },
      "c".repeat(64),
      root,
    )
    print({
      duplicate: JSON.stringify(committed) === JSON.stringify(duplicate),
      conflict,
      pid: process.pid,
      work: work.count,
    })
    process.stdout.write("READY\n")
    return yield* Effect.never
  }
  const rows = yield* database.db.select().from(Table).all().pipe(Effect.orDie)
  const row = rows.find((entry) => entry.session_id === parent)
  if (!row) throw new Error("Committed spoken fixture binding missing")
  const saved = yield* store.read(row.id)
  if (mode === "deleted") {
    yield* storage.create(["raya_openai_voice", saved.binding.id], saved)
    yield* database.db.delete(SessionTable).where(eq(SessionTable.id, parent)).run().pipe(Effect.orDie)
    const late = yield* refused(store.replace(saved))
    const publication = yield* refused(
      voice.spoken(
        saved.binding.id,
        {
          version: 1,
          revision: 2,
          generation: saved.binding.generation,
          providerCallID: saved.binding.providerCallID,
          items,
        },
        key,
        root,
      ),
    )
    const legacy = yield* refused(store.read(saved.binding.id))
    const after = yield* database.db.select().from(Table).all().pipe(Effect.orDie)
    print({
      safe:
        late &&
        publication &&
        legacy &&
        after.length === 1 &&
        after[0]!.session_id === other &&
        (yield* storage.list(["raya_openai_voice"])).length === 0,
      work: work.count,
    })
    return
  }
  if (mode !== "recover") {
    const spoken = row.data.spoken
    const historical =
      spoken && typeof spoken === "object" && !Array.isArray(spoken) ? (spoken as Record<string, unknown>) : undefined
    if (!historical) throw new Error("Seeded spoken snapshot missing")
    const value =
      mode === "legacy"
        ? undefined
        : mode === "expired"
          ? { ...historical, updatedAt: Date.now() - 3600001 }
          : mode === "future"
            ? { ...historical, version: 2 }
            : mode === "corrupt"
              ? { ...historical, items: "invalid" }
              : undefined
    if (!value && mode !== "legacy") throw new Error("Unknown spoken restart mode")
    yield* database.db
      .update(Table)
      .set({
        data: {
          ...row.data,
          spoken: value,
          ...(mode === "expired"
            ? {
                binding: { ...saved.binding, createdAt: Date.now() - 3601000, expiresAt: Date.now() - 1000 },
              }
            : {}),
        },
      })
      .where(eq(Table.id, row.id))
      .run()
      .pipe(Effect.orDie)
  }
  const old = mode === "recover" ? yield* voice.start(start, key, root) : saved.binding
  const oldWriteRefused =
    mode === "recover"
      ? yield* refused(
          voice.spoken(
            old.id,
            { version: 1, revision: 2, generation: old.generation, providerCallID: old.providerCallID, items },
            key,
            root,
          ),
        )
      : false
  const binding = yield* admit(
    { parentSessionID: parent, providerCallID: `spoken_provider_after_${mode}`, requestID: `spoken_after_${mode}` },
    fresh,
  )
  const context = yield* voice.context(binding.id, binding.generation, fresh, root)
  if (mode !== "recover") {
    print({ safe: context.items.length === 0 && (mode === "legacy" || context.incomplete), work: work.count })
    return
  }
  const sibling = yield* admit(
    { parentSessionID: other, providerCallID: "spoken_other_after", requestID: "spoken_other_after" },
    "d".repeat(64),
  )
  const separate = yield* voice.context(sibling.id, sibling.generation, "d".repeat(64), root)
  const failures = [
    yield* refused(voice.context(binding.id, binding.generation, key, root)),
    yield* refused(voice.context(binding.id, "stale-generation", fresh, root)),
    yield* refused(voice.context(binding.id, binding.generation, fresh, path.join(root, "storage"))),
    yield* refused(
      voice.spoken(
        binding.id,
        {
          version: 1,
          revision: 1,
          generation: binding.generation,
          providerCallID: old.providerCallID,
          items,
        },
        fresh,
        root,
      ),
    ),
    separate.items.every((entry) => entry.text === "Other task secret"),
    separate.items.length === 1,
  ]
  print({
    oldClosed: old.status === "closed",
    oldWriteRefused,
    newCapability: binding.id !== old.id && binding.generation !== old.generation,
    scopeRefused: failures.every(Boolean),
    ordered: context.items.map((entry) => entry.text),
    excluded: context.items.every((entry) => entry.itemID === "input" || entry.itemID === "output"),
    work: work.count,
  })
})

await Effect.runPromise(
  run.pipe(
    Effect.provide([
      Database.layerFromPath(path.join(root, "voice.sqlite")),
      Storage.layerFromDir(path.join(root, "storage")),
    ]),
    Effect.provide(layer),
    Effect.scoped,
  ),
)
