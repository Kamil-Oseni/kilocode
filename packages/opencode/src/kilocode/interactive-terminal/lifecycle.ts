import { Effect, ManagedRuntime, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ReviewGate } from "@/kilocode/session/review-gate"
import { WorkspaceOccupancy } from "@/kilocode/session/workspace-occupancy"
import { root } from "@/kilocode/session/review-workspace"
import { KiloShutdown } from "@/kilocode/cli/shutdown"
import { BackgroundProcessRunner } from "@/kilocode/background-process/runner"
import { allowed, locked, witness } from "@/kilocode/background-process/lifecycle"
import type { SessionID } from "@/session/schema"
import type { InstanceContext } from "@/project/instance-context"
import { Global } from "@opencode-ai/core/global"
import { link, mkdir, open, opendir, realpath, stat, unlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"

const fields = {
  token: Schema.String,
  sessionID: Schema.String,
  control: Schema.String,
  real: Schema.String,
  dev: Schema.String,
  ino: Schema.String,
}
const Actor = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), ...fields }),
  Schema.Struct({
    version: Schema.Literal(2),
    ...fields,
    scope: Schema.Struct({ real: Schema.String, dev: Schema.String, ino: Schema.String }),
    reservation: WorkspaceOccupancy.Reservation,
  }),
])
const decode = Schema.decodeUnknownSync(Actor)
const directory = () => path.join(Global.Path.state, "interactive-terminal")
const file = (token: string) => path.join(directory(), `${token}.json`)
const inspect = async (ctx: InstanceContext) => {
  const real = await realpath(ctx.directory)
  const node = await stat(real, { bigint: true })
  if (!node.isDirectory()) throw new Error("Terminal owner is not a directory")
  return { real, dev: node.dev.toString(), ino: node.ino.toString() }
}
const bytes = async (file: string) => {
  const handle = await open(file, "r")
  try {
    const buffer = Buffer.alloc(4097)
    const result = await handle.read(buffer, 0, buffer.length, 0)
    if (result.bytesRead > 4096) throw new Error("Terminal owner receipt exceeds its limit")
    return buffer.subarray(0, result.bytesRead).toString("utf8")
  } finally {
    await handle.close()
  }
}
const read = async (token: string) => {
  const raw: unknown = JSON.parse(await bytes(file(token)))
  const value = decode(raw, { onExcessProperty: "error" })
  if (!raw || typeof raw !== "object" || Object.keys(raw).length !== (value.version === 2 ? 9 : 7))
    throw new Error("Terminal owner receipt has unknown fields")
  if (
    value.token !== token ||
    value.control !== path.join(directory(), `${token}.control`) ||
    !path.isAbsolute(value.real) ||
    (value.version === 2 &&
      (value.reservation.version !== 2 ||
        value.reservation.terminal !== token ||
        value.reservation.nodes.length < 1 ||
        value.reservation.nodes.length > 2 ||
        value.reservation.nodes.some((node) => !path.isAbsolute(node.real))))
  )
    throw new Error("Terminal owner receipt is invalid")
  return value
}

/** Unknown historical actors remain blocked until their original owner proves actual drainage. */
export async function assert(ctx: InstanceContext, sessionID: SessionID, tokens: readonly string[]) {
  return locked(() => check(ctx, sessionID, tokens))
}
async function check(ctx: InstanceContext, sessionID: SessionID, tokens: readonly string[]) {
  await mkdir(directory(), { recursive: true, mode: 0o700 })
  const owner = await inspect(ctx)
  const entries = await opendir(directory())
  let count = 0
  for await (const entry of entries) {
    if (++count > 32768) throw new Error("Terminal ownership inspection exceeds its limit")
    if (!entry.name.endsWith(".json")) continue
    if (!entry.isFile() || !/^[a-f0-9-]{36}\.json$/.test(entry.name))
      throw new Error("Unknown terminal ownership receipt")
    const actor = await read(entry.name.slice(0, -5))
    if (actor.sessionID !== sessionID) continue
    if (actor.real !== owner.real || actor.dev !== owner.dev || actor.ino !== owner.ino)
      throw new Error("Historical terminal ownership is unverified; organization archive remains blocked")
    if (tokens.includes(actor.token)) continue
    if (actor.version !== 2 || actor.reservation.sessionID !== sessionID)
      throw new Error("Historical terminal ownership is unverified; organization archive remains blocked")
    const saved = await witness(sessionID)
    const persisted = await inspect({ ...ctx, directory: saved })
    if (JSON.stringify(persisted) !== JSON.stringify(owner))
      throw new Error("Historical terminal session owner changed")
    await runtime.runPromise(
      Effect.gen(function* () {
        const gate = yield* ReviewGate.Service
        const occupancy = yield* WorkspaceOccupancy.Service
        yield* gate.withWorkspaces([
          ctx.directory,
          root(ctx.directory, ctx.worktree),
          ...actor.reservation.nodes.map((node) => node.real),
        ])(
          Effect.gen(function* () {
            const current = yield* Effect.promise(() => read(actor.token))
            if (JSON.stringify(current) !== JSON.stringify(actor))
              throw new Error("Historical terminal receipt changed")
            const context = yield* Effect.promise(() => inspect(ctx))
            const saved = yield* Effect.promise(() => witness(sessionID))
            const persisted = yield* Effect.promise(() => inspect({ ...ctx, directory: saved }))
            const scope = yield* Effect.promise(() => inspect({ ...ctx, directory: root(ctx.directory, ctx.worktree) }))
            if (
              context.real !== actor.real ||
              context.dev !== actor.dev ||
              context.ino !== actor.ino ||
              JSON.stringify(persisted) !== JSON.stringify(context) ||
              JSON.stringify(scope) !== JSON.stringify(actor.scope)
            )
              throw new Error("Historical terminal owner changed during reconciliation")
            for (const node of actor.reservation.nodes) {
              const found = yield* Effect.promise(() => inspect({ ...ctx, directory: node.real }))
              if (JSON.stringify(found) !== JSON.stringify(node))
                throw new Error("Historical terminal workspace changed")
            }
            if (
              !(yield* Effect.promise(() => BackgroundProcessRunner.contained(actor.control, actor.token))) ||
              !(yield* Effect.promise(() => BackgroundProcessRunner.drained(actor.control, actor.token)))
            )
              throw new Error("Historical terminal drainage is unverified")
            yield* occupancy.retire(actor.reservation)
            yield* Effect.promise(() => unlink(file(actor.token)))
            yield* occupancy.forget(actor.reservation)
          }),
        )
      }),
    )
  }
}

const runtime = ManagedRuntime.make(AppNodeBuilder.build(LayerNode.group([ReviewGate.node, WorkspaceOccupancy.node])))
KiloShutdown.register(() => runtime.dispose())

/** Reserve before the native process opens; completion releases only after its private drain witness. */
async function reserve(ctx: InstanceContext, sessionID: string, cwd: string, token: string) {
  const release = await runtime.runPromise(
    Effect.gen(function* () {
      const gate = yield* ReviewGate.Service
      const occupancy = yield* WorkspaceOccupancy.Service
      return yield* gate.withWorkspaces([ctx.directory, root(ctx.directory, ctx.worktree), cwd])(
        occupancy.reserve({ ...ctx, directory: cwd }, sessionID, token),
      )
    }),
  )
  return { identity: release.identity, release: () => runtime.runPromise(release.release) }
}

/** Serialize only native admission with persisted organization tombstones, never command execution. */
export function admit<A>(
  ctx: InstanceContext,
  sessionID: SessionID,
  cwd: string,
  token: string,
  body: (release: () => Promise<void>) => Promise<A>,
) {
  return locked(async () => {
    await allowed(sessionID)
    const owner = await inspect(ctx)
    await mkdir(directory(), { recursive: true, mode: 0o700 })
    const entries = await opendir(directory())
    let count = 0
    for await (const _entry of entries)
      if (++count >= 32768)
        throw new Error("Terminal ownership limit reached; reconcile its workers before starting more")
    const scope = await inspect({ ...ctx, directory: root(ctx.directory, ctx.worktree) })
    const reservation = await reserve(ctx, sessionID, cwd, token)
    const content = JSON.stringify({
      version: 2,
      token,
      sessionID,
      control: path.join(directory(), `${token}.control`),
      ...owner,
      scope,
      reservation: reservation.identity,
    })
    if (Buffer.byteLength(content) > 4096) {
      await reservation.release()
      throw new Error("Terminal owner receipt exceeds its limit")
    }
    const temp = `${file(token)}.${randomUUID()}.tmp`
    let created = false
    try {
      await writeFile(temp, content, { flag: "wx", mode: 0o600 })
      created = true
      await link(temp, file(token))
      await unlink(temp)
    } catch (err) {
      // No native body has opened. Release only this exact occupancy actor and preserve conflicting receipts.
      await reservation.release()
      if (
        created &&
        (await bytes(temp).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        })) === content
      )
        await unlink(temp)
      throw err
    }
    return body(async () => {
      const actor = await read(token)
      if (
        actor.version !== 2 ||
        JSON.stringify(actor.reservation) !== JSON.stringify(reservation.identity) ||
        JSON.stringify(actor.scope) !== JSON.stringify(scope) ||
        actor.sessionID !== sessionID ||
        actor.real !== owner.real ||
        actor.dev !== owner.dev ||
        actor.ino !== owner.ino
      )
        throw new Error("Terminal ownership changed before drainage")
      await runtime.runPromise(WorkspaceOccupancy.Service.use((occupancy) => occupancy.retire(reservation.identity)))
      await unlink(file(token))
      await runtime.runPromise(WorkspaceOccupancy.Service.use((occupancy) => occupancy.forget(reservation.identity)))
    })
  })
}
