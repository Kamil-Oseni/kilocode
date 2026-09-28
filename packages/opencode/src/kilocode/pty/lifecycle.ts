import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Context, Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { KiloPtyLifecycle } from "@opencode-ai/core/kilocode/pty/lifecycle"
import { NativeProcess } from "@opencode-ai/core/kilocode/process-host/index"
import { Project } from "@/project/project"
import { SessionID } from "@/session/schema"
import { acquire, authorize } from "@/kilocode/background-process/lifecycle"
import { ReviewGate } from "@/kilocode/session/review-gate"
import { WorkspaceOccupancy } from "@/kilocode/session/workspace-occupancy"
import { root } from "@/kilocode/session/review-workspace"

const Physical = Schema.Struct({ real: Schema.String, dev: Schema.String, ino: Schema.String })
const Identity = Schema.Struct({
  pid: Schema.Number,
  birth: Schema.String,
  helper: Schema.Number,
  helperBirth: Schema.String,
})
const Actor = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  token: Schema.String,
  control: Schema.String,
  sessionID: Schema.NullOr(Schema.String),
  workspaceID: Schema.NullOr(Schema.String),
  projectID: Schema.String,
  directory: Schema.String,
  root: Schema.String,
  cwd: Schema.String,
  owner: Physical,
  scope: Physical,
  target: Physical,
  reservation: WorkspaceOccupancy.Reservation,
  phase: Schema.Literals(["reserved", "starting", "admitted"]),
  identity: Schema.NullOr(Identity),
})
type Actor = typeof Actor.Type
const decode = Schema.decodeUnknownSync(Actor)
const same = isDeepStrictEqual
const inspect = async (directory: string) => {
  const real = await fs.realpath(directory)
  const stat = await fs.stat(real, { bigint: true })
  if (!stat.isDirectory()) throw new Error("Terminal workspace is not a directory")
  return { real, dev: stat.dev.toString(), ino: stat.ino.toString() }
}
const bounded = async (file: string) => {
  const handle = await fs.open(file, "r")
  try {
    const buffer = Buffer.alloc(16_385)
    const result = await handle.read(buffer, 0, buffer.length, 0)
    if (result.bytesRead > 16_384) throw new Error("Terminal authority receipt exceeds its limit")
    return JSON.parse(buffer.subarray(0, result.bytesRead).toString("utf8")) as unknown
  } finally {
    await handle.close()
  }
}
const attempt = <A>(body: () => Promise<A>) => Effect.tryPromise(body).pipe(Effect.orDie)

export interface Interface {
  readonly assert: (sessionID: SessionID, directory: string) => Effect.Effect<void>
}
export class Service extends Context.Service<Service, Interface>()("@raya/PtyOwners") {}

/** Immutable creation owners remain authoritative after display attribution or backend lifetime changes. */
export const node = LayerNode.make({
  service: KiloPtyLifecycle.Service,
  tag: KiloPtyLifecycle.node.tag,
  layer: Layer.unwrap(
    Effect.gen(function* () {
      const global = yield* Global.Service
      const database = yield* Database.Service
      const project = yield* Project.Service
      const gate = yield* ReviewGate.Service
      const occupancy = yield* WorkspaceOccupancy.Service
      const directory = path.join(global.state, "core-pty-v1")
      const file = (token: string) => path.join(directory, `${token}.json`)
      const read = async (token: string) => {
        const value = decode(await bounded(file(token)), { onExcessProperty: "error" })
        if (
          !/^[a-f0-9-]{36}$/.test(token) ||
          value.token !== token ||
          value.control !== path.join(directory, `${token}.control`) ||
          value.reservation.version !== 2 ||
          value.reservation.terminal !== token ||
          value.reservation.sessionID !== (value.sessionID ?? `pty:${value.id}`) ||
          ![value.directory, value.root, value.cwd].every((directory) => path.isAbsolute(directory)) ||
          value.reservation.nodes.length < 1 ||
          value.reservation.nodes.length > 2 ||
          !same(value.reservation.nodes[0], value.target) ||
          !same(value.reservation.nodes[value.reservation.nodes.length - 1], value.scope)
        )
          throw new Error("Terminal authority receipt is inconsistent")
        return value
      }
      const publish = async (actor: Actor, previous?: Actor) => {
        const source = JSON.stringify(actor)
        if (Buffer.byteLength(source) > 16_384) throw new Error("Terminal authority receipt exceeds its limit")
        const temp = path.join(directory, `${actor.token}.${randomUUID()}.tmp`)
        await fs.writeFile(temp, source, { flag: "wx", mode: 0o600 })
        try {
          if (!previous) return await fs.link(temp, file(actor.token))
          if (!same(await read(actor.token), previous)) throw new Error("Terminal authority receipt changed")
          await fs.rename(temp, file(actor.token))
        } finally {
          await fs.unlink(temp).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== "ENOENT") throw err
          })
        }
      }
      const locked = <A>(body: Effect.Effect<A>) =>
        Effect.acquireUseRelease(
          attempt(acquire),
          () => body,
          (lease) => attempt(() => lease.release()),
        )
      const verify = (actor: Actor) =>
        Effect.gen(function* () {
          if (
            !same(yield* attempt(() => inspect(actor.directory)), actor.owner) ||
            !same(yield* attempt(() => inspect(actor.root)), actor.scope) ||
            !same(yield* attempt(() => inspect(actor.cwd)), actor.target)
          )
            throw new Error("Terminal workspace identity changed")
          if (actor.sessionID) {
            const row = yield* database.db
              .select()
              .from(SessionTable)
              .where(eq(SessionTable.id, SessionID.make(actor.sessionID)))
              .get()
              .pipe(Effect.orDie)
            if (
              !row ||
              row.project_id !== actor.projectID ||
              (row.workspace_id ?? null) !== actor.workspaceID ||
              !same(yield* attempt(() => inspect(row.directory)), actor.owner)
            )
              throw new Error("Terminal session owner changed")
          }
        })
      const retire = (actor: Actor, proof?: KiloPtyLifecycle.Proof, progress = { removed: false }) =>
        Effect.gen(function* () {
          if (proof && !same(proof, { version: 2, token: actor.token, proof: "windows-job", empty: true }))
            throw new Error("Terminal drainage proof does not match its owner")
          yield* verify(actor)
          if (progress.removed) {
            const exists = yield* attempt(async () =>
              fs.lstat(file(actor.token)).then(
                () => true,
                (err: NodeJS.ErrnoException) => {
                  if (err.code === "ENOENT") return false
                  throw err
                },
              ),
            )
            if (exists) throw new Error("A retired terminal authority receipt was replaced")
            yield* occupancy.forget(actor.reservation)
            return
          }
          const saved = yield* attempt(() => read(actor.token))
          if (!same(saved, actor) || actor.phase !== "admitted" || !actor.identity)
            throw new Error("Terminal admission identity is uncertain")
          const assigned = yield* attempt(() => bounded(`${actor.control}.job`))
          const drained = yield* attempt(() => bounded(`${actor.control}.drained`))
          if (
            !same(assigned, { version: 2, token: actor.token, proof: "windows-job", assigned: true }) ||
            !same(drained, { version: 2, token: actor.token, proof: "windows-job", empty: true })
          )
            throw new Error("Terminal has no exact native drainage proof")
          const identity = yield* attempt(() => NativeProcess.suspended(actor.control, actor.token))
          if (!same(identity, actor.identity)) throw new Error("Terminal native identity changed")
          const helper = yield* attempt(() => NativeProcess.inspect(identity.helper))
          if (
            !helper ||
            typeof helper !== "object" ||
            !("status" in helper) ||
            (helper.status !== "gone" &&
              !(
                helper.status === "owned" &&
                "birth" in helper &&
                typeof helper.birth === "string" &&
                helper.birth !== identity.helperBirth
              ))
          )
            throw new Error("Terminal helper drainage is uncertain")
          yield* occupancy.retire(actor.reservation)
          yield* attempt(() => fs.unlink(file(actor.token)))
          progress.removed = true
          yield* occupancy.forget(actor.reservation)
        })
      const admission: KiloPtyLifecycle.Interface["admission"] = (request, body) =>
        locked(
          Effect.gen(function* () {
            const owner = yield* attempt(() => inspect(request.location.directory))
            const found = yield* project.fromDirectory(request.location.directory)
            const workspace = root(request.location.directory, found.sandbox)
            const ctx = { directory: request.cwd, worktree: workspace, project: found.project }
            const scope = yield* attempt(() => inspect(workspace))
            const target = yield* attempt(() => inspect(request.cwd))
            if (request.ownerSessionID) {
              const id = SessionID.make(request.ownerSessionID)
              const row = yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, id)).get()
              if (
                !row ||
                row.project_id !== found.project.id ||
                (row.workspace_id ?? undefined) !== request.location.workspaceID ||
                !same(yield* attempt(() => inspect(row.directory)), owner)
              )
                throw new Error("Terminal creation requires its saved session workspace")
              yield* authorize(database, id).pipe(Effect.orDie)
            }
            return yield* gate.withWorkspaces([owner.real, scope.real, target.real])(
              Effect.gen(function* () {
                yield* attempt(() => fs.mkdir(directory, { recursive: true, mode: 0o700 }))
                const entries = yield* attempt(() => fs.opendir(directory))
                yield* attempt(async () => {
                  let count = 0
                  for await (const entry of entries) {
                    if (++count > 32_768) throw new Error("Terminal authority registry exceeds its limit")
                    if (entry.name.endsWith(".json") && !entry.isFile())
                      throw new Error("Unknown terminal authority receipt")
                  }
                  if (count >= 4096) throw new Error("Terminal authority registry is full")
                })
                const token = randomUUID()
                const reservation = yield* occupancy.reserve(ctx, request.ownerSessionID ?? `pty:${request.id}`, token)
                let actor: Actor = {
                  version: 1,
                  id: request.id,
                  token,
                  control: path.join(directory, `${token}.control`),
                  sessionID: request.ownerSessionID ?? null,
                  workspaceID: request.location.workspaceID ?? null,
                  projectID: found.project.id,
                  directory: request.location.directory,
                  root: workspace,
                  cwd: request.cwd,
                  owner,
                  scope,
                  target,
                  reservation: reservation.identity,
                  phase: "reserved",
                  identity: null,
                }
                let dispatched = false
                let published = false
                const progress = { removed: false }
                return yield* Effect.gen(function* () {
                  yield* attempt(() => publish(actor))
                  published = true
                  return yield* body({
                    token,
                    control: actor.control,
                    dispatch: () =>
                      Effect.gen(function* () {
                        if (dispatched) throw new Error("Terminal native dispatch cannot be repeated")
                        yield* verify(actor)
                        if (actor.sessionID)
                          yield* authorize(database, SessionID.make(actor.sessionID)).pipe(Effect.orDie)
                        const next = { ...actor, phase: "starting" as const }
                        yield* attempt(() => publish(next, actor))
                        actor = next
                        dispatched = true
                      }),
                    admit: (identity) =>
                      Effect.gen(function* () {
                        if (!dispatched || actor.phase !== "starting")
                          throw new Error("Terminal admission is out of order")
                        const saved = yield* attempt(() => NativeProcess.suspended(actor.control, token))
                        if (!same(identity, saved)) throw new Error("Terminal suspended identity does not match")
                        yield* verify(actor)
                        if (actor.sessionID)
                          yield* authorize(database, SessionID.make(actor.sessionID)).pipe(Effect.orDie)
                        const next = { ...actor, phase: "admitted" as const, identity }
                        yield* attempt(() => publish(next, actor))
                        actor = next
                      }),
                    retire: (proof) =>
                      locked(
                        gate.withWorkspaces([owner.real, scope.real, target.real])(retire(actor, proof, progress)),
                      ),
                  })
                }).pipe(
                  Effect.ensuring(
                    Effect.gen(function* () {
                      if (dispatched) return
                      if (published && !same(yield* attempt(() => read(token)), actor))
                        throw new Error("Unlaunched terminal authority receipt changed")
                      yield* reservation.release
                      if (published) yield* attempt(() => fs.unlink(file(token)))
                    }),
                  ),
                )
              }),
            )
          }).pipe(Effect.orDie),
        )
      const assert = (sessionID: SessionID, owner: string) =>
        locked(
          Effect.gen(function* () {
            const physical = yield* attempt(() => inspect(owner))
            yield* attempt(() => fs.mkdir(directory, { recursive: true, mode: 0o700 }))
            const entries = yield* attempt(() => fs.opendir(directory))
            const tokens = yield* attempt(async () => {
              const tokens: string[] = []
              let count = 0
              for await (const entry of entries) {
                if (++count > 32_768) throw new Error("Terminal authority registry exceeds its limit")
                if (!entry.name.endsWith(".json")) continue
                if (!entry.isFile() || !/^[a-f0-9-]{36}\.json$/.test(entry.name))
                  throw new Error("Unknown terminal authority receipt")
                tokens.push(entry.name.slice(0, -5))
                if (tokens.length > 4096) throw new Error("Terminal authority registry exceeds its limit")
              }
              return tokens
            })
            for (const token of tokens) {
              const actor = yield* attempt(() => read(token))
              if (actor.sessionID !== sessionID) continue
              if (!same(actor.owner, physical)) throw new Error("Terminal archive owner changed")
              yield* gate.withWorkspaces([actor.owner.real, actor.scope.real, actor.target.real])(retire(actor))
            }
          }),
        )
      return Layer.merge(
        Layer.succeed(KiloPtyLifecycle.Service, KiloPtyLifecycle.Service.of({ admission })),
        Layer.succeed(Service, Service.of({ assert })),
      )
    }),
  ),
  deps: [Global.node, Database.node, Project.node, ReviewGate.node, WorkspaceOccupancy.node],
})

export * as PtyOwners from "./lifecycle"
