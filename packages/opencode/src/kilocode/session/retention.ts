import path from "node:path"
import { Context, Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OpenAIRetention } from "@/kilocode/voice/openai-retention"
import { cleanup } from "@/kilocode/tool/apply-patch-receipt"
import { Storage } from "@/storage/storage"

function missing(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  if ("code" in err && err.code === "ENOENT") return true
  if ("reason" in err && err.reason && typeof err.reason === "object" && "_tag" in err.reason)
    return err.reason._tag === "NotFound"
  return "cause" in err && missing(err.cause)
}

export const make = (
  fs: FSUtil.Interface,
  voice: OpenAIRetention.Service,
  storage: Storage.Interface,
  root = path.join(Global.Path.data, "storage"),
) => ({
  before: voice.remove,
  reviews: Effect.fn("SessionRetention.reviews")(function* (session: string) {
    yield* cleanup(storage, session)
    const dir = path.join(root, "review_receipt", session)
    yield* fs.remove(dir, { recursive: true }).pipe(Effect.catchIf(missing, () => Effect.void))
  }),
})

export class Service extends Context.Service<Service, ReturnType<typeof make>>()("@raya/SessionRetention") {}

export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      return make(yield* FSUtil.Service, yield* OpenAIRetention.Service, yield* Storage.Service)
    }),
  ),
  deps: [FSUtil.node, OpenAIRetention.node, Storage.node],
})

export * as SessionRetention from "./retention"
