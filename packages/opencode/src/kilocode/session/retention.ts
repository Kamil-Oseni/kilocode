import path from "node:path"
import { Context, Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OpenAIRetention } from "@/kilocode/voice/openai-retention"
import { cleanup } from "@/kilocode/tool/apply-patch-receipt"
import * as TaskFiles from "@/kilocode/tool/task-files"
import { Storage } from "@/storage/storage"
import { Database } from "@opencode-ai/core/database/database"
import { composerRetention } from "./composer-retention"

function missing(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  if ("code" in err && err.code === "ENOENT") return true
  if ("reason" in err && err.reason && typeof err.reason === "object" && "_tag" in err.reason)
    return err.reason._tag === "NotFound"
  return "cause" in err && missing(err.cause)
}

const reviews = (fs: FSUtil.Interface, storage: Storage.Interface, database: Database.Interface, root: string) =>
  Effect.fn("SessionRetention.reviews")(function* (session: string) {
    yield* cleanup(storage, session)
    yield* TaskFiles.clear(storage, session)
    const files = yield* database.db.all<{ name: string; file: string }>("PRAGMA database_list")
    const selected = files.find((file) => file.name === "main")
    if (!selected) return yield* Effect.fail(new Error("The selected session database is unavailable."))
    yield* composerRetention(database, storage, root, selected.file || ":memory:").eraseSession(session)
    const dir = path.join(root, "review_receipt", session)
    return yield* fs.remove(dir, { recursive: true }).pipe(Effect.catchIf(missing, () => Effect.void))
  })

export interface Interface {
  readonly before: ReturnType<typeof OpenAIRetention.make>["remove"]
  readonly reviews: ReturnType<typeof reviews>
}

export const make = (
  fs: FSUtil.Interface,
  voice: ReturnType<typeof OpenAIRetention.make>,
  storage: Storage.Interface,
  database: Database.Interface,
  root = path.join(Global.Path.data, "storage"),
): Interface => ({
  before: voice.remove,
  reviews: reviews(fs, storage, database, root),
})

export class Service extends Context.Service<Service, Interface>()("@raya/SessionRetention") {}

export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      return Service.of(
        make(yield* FSUtil.Service, yield* OpenAIRetention.Service, yield* Storage.Service, yield* Database.Service),
      )
    }),
  ),
  deps: [FSUtil.node, OpenAIRetention.node, Storage.node, Database.node],
})

export * as SessionRetention from "./retention"
