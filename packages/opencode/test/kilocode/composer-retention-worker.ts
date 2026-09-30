import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { composerRetention } from "@/kilocode/session/composer-retention"
import {
  composerDrafts,
  DraftError,
  type DraftContent,
  type DraftIdentity,
  type DraftToken,
} from "@/kilocode/session/composer-drafts"

export type Request = {
  dir: string
  file: string
  receipt: string
  operation: "save" | "clear" | "load" | "promote" | "legacy"
  who: DraftIdentity
  content: DraftContent
  mutation: string
  token?: DraftToken
  target?: DraftIdentity
  checkpoint?: { stage: string; file: string }
}

const input: Request = await Bun.file(process.argv[2]).json()
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const database = yield* Database.Service
    const drafts = composerRetention(database, storage, input.dir, input.file, {
      checkpoint: (stage) =>
        stage !== input.checkpoint?.stage
          ? Effect.void
          : Effect.gen(function* () {
              yield* Effect.promise(() => Bun.write(input.checkpoint!.file, stage))
              yield* Effect.never
            }),
    })
    if (input.operation === "legacy")
      return yield* composerDrafts(storage, input.dir).save(input.who, undefined, input.content, input.mutation)
    if (input.operation === "load") return yield* drafts.load(input.who)
    if (input.operation === "save") return yield* drafts.save(input.who, input.token, input.content, input.mutation)
    if (input.operation === "clear") {
      if (!input.token) return yield* Effect.fail(new DraftError("invalid"))
      return yield* drafts.clear(input.who, input.token, input.mutation)
    }
    if (!input.token || !input.target) return yield* Effect.fail(new DraftError("invalid"))
    return yield* drafts.promote(input.who, input.target, input.token, undefined, input.mutation)
  }).pipe(
    Effect.map((value) => ({ ok: true, value })),
    Effect.catch((err) =>
      err instanceof DraftError ? Effect.succeed({ ok: false, code: err.code }) : Effect.fail(err),
    ),
    Effect.provide(Layer.merge(Database.layerFromPath(input.file), Storage.layerFromDir(input.dir))),
    Effect.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))),
  ),
)
await Bun.write(input.receipt, JSON.stringify(result))
