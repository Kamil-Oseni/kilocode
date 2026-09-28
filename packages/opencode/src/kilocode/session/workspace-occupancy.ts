import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Global } from "@opencode-ai/core/global"
import { NativeProcess } from "@opencode-ai/core/kilocode/process-host/index"
import type { InstanceContext } from "@/project/instance-context"
import { ReviewConflict } from "./review-revision"
import { root } from "./review-workspace"

const Node = Schema.Struct({ real: Schema.String, dev: Schema.String, ino: Schema.String })
const fields = {
  token: Schema.String,
  backend: Schema.String,
  pid: Schema.Number,
  sessionID: Schema.String,
  nodes: Schema.Array(Node),
}
export const Reservation = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), ...fields }),
  Schema.Struct({ version: Schema.Literal(2), ...fields, terminal: Schema.String }),
])
export type Reservation = typeof Reservation.Type
const decode = Schema.decodeUnknownSync(Reservation)
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
    const raw: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"))
    const actor = decode(raw, { onExcessProperty: "error" })
    if (
      !raw ||
      typeof raw !== "object" ||
      Object.keys(raw).length !== (actor.version === 2 ? 7 : 6) ||
      actor.nodes.some((node) => Object.keys(node).length !== 3)
    )
      throw new Error("Workspace reservation has unknown fields")
    return actor
  } finally {
    await handle.close()
  }
}

export interface Interface {
  readonly reserve: (
    ctx: InstanceContext,
    sessionID: string,
    terminal?: string,
  ) => Effect.Effect<{ identity: Reservation; release: Effect.Effect<void> }>
  readonly retire: (identity: Reservation) => Effect.Effect<void>
  readonly forget: (identity: Reservation, expected?: NativeProcess.Receipt) => Effect.Effect<void>
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
      const receipts = path.join(global.state, "workspace-occupancy-released-v1")
      const same = (a: Reservation, b: Reservation) => JSON.stringify(a) === JSON.stringify(b)
      const validate = (identity: Reservation) => {
        const actor = decode(identity)
        if (
          !/^[a-f0-9-]{36}$/.test(actor.token) ||
          !Number.isSafeInteger(actor.pid) ||
          actor.pid <= 0 ||
          !/^[a-f0-9-]{36}$/.test(actor.backend) ||
          (actor.version === 2 && !/^[a-f0-9-]{36}$/.test(actor.terminal)) ||
          !actor.nodes.length ||
          actor.nodes.length > 2 ||
          actor.nodes.some((node) => !path.isAbsolute(node.real))
        )
          throw new Error("Invalid workspace reservation identity")
        return actor
      }
      const optional = async (file: string) =>
        read(file).catch((err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") return undefined
          throw err
        })
      const retire = (identity: Reservation) =>
        locked(
          Effect.promise(async () => {
            const actor = validate(identity)
            const file = path.join(directory, `${actor.token}.json`)
            const receipt = path.join(receipts, `${actor.token}.json`)
            await fs.mkdir(receipts, { recursive: true, mode: 0o700 })
            const previous = await optional(receipt)
            const current = await optional(file)
            if ((previous && !same(previous, actor)) || (current && !same(current, actor)))
              throw new Error("Workspace reservation ownership changed")
            if (!previous && !current) throw new Error("Workspace reservation has no confirmed release receipt")
            if (!previous) {
              const entries = await fs.opendir(receipts)
              let count = 0
              for await (const _entry of entries)
                if (++count >= 4096) throw new Error("Workspace release receipts need reconciliation")
              // A hard link atomically publishes the exact actor before retiring occupancy.
              await fs.link(file, receipt)
            }
            if (current) await fs.unlink(file)
          }),
        )
      const forget = (identity: Reservation, expected?: NativeProcess.Receipt) =>
        locked(
          Effect.promise(async () => {
            const actor = validate(identity)
            const file = path.join(receipts, `${actor.token}.json`)
            if (expected) {
              const saved = decode(
                JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(expected.data, "base64"))),
                {
                  onExcessProperty: "error",
                },
              )
              if (!same(saved, actor)) throw new Error("Workspace release receipt ownership changed")
              if (await optional(path.join(directory, `${actor.token}.json`)))
                throw new Error("Workspace reservation remains occupied")
              await NativeProcess.remove(file, expected)
              return
            }
            const receipt = await optional(file)
            if (!receipt) return
            if (!same(receipt, actor)) throw new Error("Workspace release receipt ownership changed")
            if (await optional(path.join(directory, `${actor.token}.json`)))
              throw new Error("Workspace reservation remains occupied")
            await fs.unlink(file)
          }),
        )
      const reserve = (ctx: InstanceContext, sessionID: string, terminal?: string) =>
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
            const identity = validate(
              decode({
                version: terminal === undefined ? 1 : 2,
                token,
                backend,
                pid: process.pid,
                sessionID,
                nodes,
                ...(terminal === undefined ? {} : { terminal }),
              }),
            )
            const content = JSON.stringify(identity)
            if (Buffer.byteLength(content) > limit) throw new Error("Workspace occupancy owner is too large")
            await fs.writeFile(file, content, { flag: "wx", mode: 0o600 })
            // Only the registry mutex is reacquired. Reviews refuse actors instead of awaiting drainage.
            return {
              identity,
              release: locked(
                Effect.promise(async () => {
                  const actor = await read(file)
                  if (!same(actor, identity)) throw new Error("Workspace occupancy ownership changed")
                  await fs.unlink(file)
                }),
              ),
            }
          }),
        )
      const register = (ctx: InstanceContext, sessionID: string) =>
        reserve(ctx, sessionID).pipe(Effect.map((actor) => actor.release))
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
      return Service.of({ register, reserve, retire, forget, review })
    }),
  ),
  deps: [Global.node, EffectFlock.node],
})

export * as WorkspaceOccupancy from "./workspace-occupancy"
