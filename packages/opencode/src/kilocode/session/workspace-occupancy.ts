import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Global } from "@opencode-ai/core/global"
import type { InstanceContext } from "@/project/instance-context"
import { ReviewConflict } from "./review-revision"
import { root } from "./review-workspace"

const Node = Schema.Struct({ real: Schema.String, dev: Schema.String, ino: Schema.String })
const Actor = Schema.Struct({
  version: Schema.Literal(1),
  token: Schema.String,
  backend: Schema.String,
  pid: Schema.Number,
  sessionID: Schema.String,
  nodes: Schema.Array(Node),
})
const decode = Schema.decodeUnknownSync(Actor)
const backend = randomUUID()
const limit = 65_536
const canonical = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value)
const contains = (parent: string, child: string) => {
  const relative = path.relative(canonical(parent), canonical(child))
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}
const inspect = async (directory: string) => {
  const real = await fs.realpath(directory)
  const stat = await fs.stat(real, { bigint: true })
  if (!stat.isDirectory()) throw new Error("Workspace is not a directory")
  return { real, dev: stat.dev.toString(), ino: stat.ino.toString() }
}
const read = async (file: string) => {
  const handle = await fs.open(file, "r")
  try {
    const buffer = Buffer.alloc(limit + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > limit) throw new Error("Oversized occupancy record")
    return decode(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")))
  } finally {
    await handle.close()
  }
}

export interface Interface {
  readonly register: (ctx: InstanceContext, sessionID: string) => Effect.Effect<Effect.Effect<void>>
  readonly review: (
    directories: readonly string[],
  ) => <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<A, E | ReviewConflict, R>
}
export class Service extends Context.Service<Service, Interface>()("@raya/WorkspaceOccupancy") {}

/** Durable unknown actors fail closed; only their exact drained execution removes a record. */
export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      const global = yield* Global.Service
      const flock = yield* EffectFlock.Service
      const directory = path.join(global.state, "workspace-occupancy-v1")
      const locked = <A, E, R>(body: Effect.Effect<A, E, R>) =>
        flock
          .withLock(body, "workspace-occupancy-v1")
          .pipe(Effect.catchTag("LockTimeoutError", Effect.die), Effect.catchTag("LockCompromisedError", Effect.die))
      const register = (ctx: InstanceContext, sessionID: string) =>
        locked(
          Effect.promise(async () => {
            const nodes = await Promise.all(
              [...new Set([ctx.directory, root(ctx.directory, ctx.worktree)])].map(inspect),
            )
            const token = randomUUID()
            const file = path.join(directory, `${token}.json`)
            await fs.mkdir(directory, { recursive: true, mode: 0o700 })
            const entries = await fs.opendir(directory)
            let count = 0
            for await (const _entry of entries)
              if (++count >= 4096)
                throw new Error("Workspace activity limit reached. Reconcile its workers before starting more work.")
            const content = JSON.stringify({ version: 1, token, backend, pid: process.pid, sessionID, nodes })
            if (Buffer.byteLength(content) > limit) throw new Error("Workspace occupancy owner is too large")
            await fs.writeFile(file, content, { flag: "wx", mode: 0o600 })
            // Only the registry mutex is reacquired. Reviews refuse actors instead of awaiting drainage.
            return locked(
              Effect.promise(async () => {
                const actor = await read(file)
                if (actor.token !== token || actor.backend !== backend || actor.pid !== process.pid)
                  throw new Error("Workspace occupancy ownership changed")
                await fs.unlink(file)
              }),
            )
          }),
        )
      const review: Interface["review"] = (directories) => (body) =>
        locked(
          Effect.gen(function* () {
            const check = yield* Effect.tryPromise({
              try: async () => {
                const nodes = await Promise.all([...new Set(directories)].map(inspect))
                await fs.mkdir(directory, { recursive: true, mode: 0o700 })
                const entries = await fs.opendir(directory)
                let count = 0
                for await (const entry of entries) {
                  if (++count > 4096) throw new Error("Workspace occupancy needs reconciliation")
                  if (!entry.isFile() || !/^[a-f0-9-]{36}\.json$/.test(entry.name))
                    throw new Error("Unknown workspace occupancy record")
                  const actor = await read(path.join(directory, entry.name))
                  if (entry.name !== `${actor.token}.json` || !actor.nodes.length || actor.nodes.length > 2)
                    throw new Error("Invalid workspace occupancy owner")
                  if (actor.nodes.some((item) => !path.isAbsolute(item.real)))
                    throw new Error("Invalid workspace occupancy path")
                  if (
                    actor.nodes.some((item) =>
                      nodes.some(
                        (node) =>
                          (item.dev === node.dev && item.ino === node.ino) ||
                          contains(item.real, node.real) ||
                          contains(node.real, item.real),
                      ),
                    )
                  )
                    return false
                }
                return true
              },
              catch: () =>
                new ReviewConflict({
                  message: "Workspace activity could not be verified. Reconcile its workers before reviewing files.",
                }),
            })
            if (!check)
              return yield* new ReviewConflict({
                message:
                  "This workspace still has running or unverified work. Wait for its workers to finish before reviewing files.",
              })
            return yield* body
          }),
        )
      return Service.of({ register, review })
    }),
  ),
  deps: [Global.node, EffectFlock.node],
})

export * as WorkspaceOccupancy from "./workspace-occupancy"
