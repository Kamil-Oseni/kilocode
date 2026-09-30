import { Effect } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import {
  composerDrafts,
  DraftError,
  type DraftIdentity,
  type DraftContent,
  type DraftToken,
} from "@/kilocode/session/composer-drafts"

const input: {
  dir: string
  receipt: string
  who: DraftIdentity
  content: DraftContent
  token?: DraftToken
  mutation: string
} = await Bun.file(process.argv[2]).json()
const result = await Effect.runPromise(
  Storage.Service.use((store) =>
    composerDrafts(store, input.dir)
      .save(input.who, input.token, input.content, input.mutation)
      .pipe(
        Effect.map((item) => ({ ok: true, token: item.token, mutation: item.mutation })),
        Effect.catch((err) => Effect.succeed({ ok: false, code: err instanceof DraftError ? err.code : "storage" })),
      ),
  ).pipe(
    Effect.provide(Storage.layerFromDir(input.dir)),
    Effect.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))),
  ),
)
await Bun.write(input.receipt, JSON.stringify(result))
