import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionID } from "@/session/schema"

function missing(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  if ("code" in err && err.code === "ENOENT") return true
  if ("reason" in err && err.reason && typeof err.reason === "object" && "_tag" in err.reason)
    return err.reason._tag === "NotFound"
  return "cause" in err && missing(err.cause)
}

function parent(value: unknown) {
  if (!value || typeof value !== "object" || !("binding" in value)) return undefined
  const binding = value.binding
  if (!binding || typeof binding !== "object" || !("parentSessionID" in binding)) return undefined
  return Schema.is(SessionID)(binding.parentSessionID) ? binding.parentSessionID : undefined
}

/** Legacy cleanup is strict: an unreadable directory or record must not look like successful erasure. */
export const make = (fs: FSUtil.Interface, root = path.join(Global.Path.data, "storage")) => ({
  remove: Effect.fn("OpenAIRetention.remove")(function* (session: string) {
    const dir = path.join(root, "raya_openai_voice")
    const entries = yield* fs.readDirectoryEntries(dir).pipe(Effect.catchIf(missing, () => Effect.succeed([])))
    for (const entry of entries) {
      if (!/^[a-zA-Z0-9_-]{1,128}\.json$/.test(entry.name) && !/^\.review-[a-zA-Z0-9_-]+\.tmp$/.test(entry.name)) continue
      if (entry.type !== "file")
        return yield* Effect.fail(new FSUtil.FileSystemError({ method: "voice retention: unexpected record type" }))
      const file = path.join(dir, entry.name)
      const record = yield* fs.readJson(file).pipe(
        Effect.catchIf(missing, () => Effect.succeed(undefined)),
        Effect.mapError(() => new FSUtil.FileSystemError({ method: "voice retention: unreadable record" })),
      )
      if (record === undefined) continue
      if (parent(record) === undefined)
        return yield* Effect.fail(new FSUtil.FileSystemError({ method: "voice retention: unidentified record owner" }))
      if (parent(record) !== session) continue
      yield* fs.remove(file).pipe(Effect.catchIf(missing, () => Effect.void))
    }
    return undefined
  }),
})

export class Service extends Context.Service<Service, ReturnType<typeof make>>()("@raya/OpenAIRetention") {}

export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(Service, Effect.map(FSUtil.Service, (fs) => make(fs))),
  deps: [FSUtil.node],
})

export * as OpenAIRetention from "./openai-retention"
