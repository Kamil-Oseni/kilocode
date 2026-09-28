import { Effect, ManagedRuntime, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ReviewGate } from "@/kilocode/session/review-gate"
import { WorkspaceOccupancy } from "@/kilocode/session/workspace-occupancy"
import { root } from "@/kilocode/session/review-workspace"
import { KiloShutdown } from "@/kilocode/cli/shutdown"
import { allowed, locked } from "@/kilocode/background-process/lifecycle"
import type { SessionID } from "@/session/schema"
import type { InstanceContext } from "@/project/instance-context"
import { Global } from "@opencode-ai/core/global"
import { link, mkdir, open, opendir, realpath, stat, unlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"

const Actor = Schema.Struct({
  version: Schema.Literal(1),
  token: Schema.String,
  sessionID: Schema.String,
  control: Schema.String,
  real: Schema.String,
  dev: Schema.String,
  ino: Schema.String,
})
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
  const value = decode(JSON.parse(await bytes(file(token))))
  if (
    value.token !== token ||
    value.control !== path.join(directory(), `${token}.control`) ||
    !path.isAbsolute(value.real)
  )
    throw new Error("Terminal owner receipt is invalid")
  return value
}

/** Unknown historical actors remain blocked until their original owner proves actual drainage. */
export async function assert(ctx: InstanceContext, sessionID: SessionID, tokens: readonly string[]) {
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
    if (
      !tokens.includes(actor.token) ||
      actor.real !== owner.real ||
      actor.dev !== owner.dev ||
      actor.ino !== owner.ino
    )
      throw new Error("Historical terminal ownership is unverified; organization archive remains blocked")
  }
}

const runtime = ManagedRuntime.make(AppNodeBuilder.build(LayerNode.group([ReviewGate.node, WorkspaceOccupancy.node])))
KiloShutdown.register(() => runtime.dispose())

/** Reserve before the native process opens; completion releases only after its private drain witness. */
async function reserve(ctx: InstanceContext, sessionID: string, cwd: string) {
  const release = await runtime.runPromise(
    Effect.gen(function* () {
      const gate = yield* ReviewGate.Service
      const occupancy = yield* WorkspaceOccupancy.Service
      return yield* gate.withWorkspaces([ctx.directory, root(ctx.directory, ctx.worktree), cwd])(
        occupancy.register({ ...ctx, directory: cwd }, sessionID),
      )
    }),
  )
  return () => runtime.runPromise(release)
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
    const content = JSON.stringify({
      version: 1,
      token,
      sessionID,
      control: path.join(directory(), `${token}.control`),
      ...owner,
    })
    if (Buffer.byteLength(content) > 4096) throw new Error("Terminal owner receipt exceeds its limit")
    const release = await reserve(ctx, sessionID, cwd)
    const temp = `${file(token)}.${randomUUID()}.tmp`
    let created = false
    try {
      await writeFile(temp, content, { flag: "wx", mode: 0o600 })
      created = true
      await link(temp, file(token))
      await unlink(temp)
    } catch (err) {
      // No native body has opened. Release only this exact occupancy actor and preserve conflicting receipts.
      await release()
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
    let released = false
    return body(async () => {
      const actor = await read(token)
      if (
        actor.sessionID !== sessionID ||
        actor.real !== owner.real ||
        actor.dev !== owner.dev ||
        actor.ino !== owner.ino
      )
        throw new Error("Terminal ownership changed before drainage")
      if (!released) {
        await release()
        released = true
      }
      await unlink(file(token))
    })
  })
}
