export * as Pty from "./pty"

import { makeGlobalNode, makeLocationNode } from "./effect/app-node" // kilocode_change
import { Context, Effect, Layer, Schema, Types } from "effect"
import { Pty } from "@opencode-ai/schema/pty"
import { Config } from "./config"
import { EventV2 } from "./event"
import { Location } from "./location"
import { PtyID } from "./pty/schema"
import { SessionSchema } from "./session/schema" // kilocode_change
import { Shell } from "./shell"
import { lazy } from "./util/lazy"
import { KiloPtySelfCommand } from "./kilocode/pty-self-command" // kilocode_change
import * as KiloPtyRegistry from "./kilocode/pty/registry" // kilocode_change
import type { Active, Subscriber } from "./kilocode/pty/registry" // kilocode_change
import { KiloPtyLifecycle, type Lease } from "./kilocode/pty/lifecycle" // kilocode_change
import { NativePty } from "./kilocode/pty/native" // kilocode_change
import { NativeProcess } from "./kilocode/process-host" // kilocode_change
import { Replay as KiloPtyReplay } from "./kilocode/pty/replay" // kilocode_change
import { Exit } from "effect" // kilocode_change

const BUFFER_LIMIT = 1024 * 1024 * 2
// Exited sessions stay observable (status, exit code, retained output) until removed explicitly.
// Cap retention so abandoned terminals do not accumulate unbounded buffers.
const EXITED_LIMIT = 25
const pty = lazy(() => import("#pty"))

// kilocode_change - the Kilo `sessionID` field now lives on the canonical shared schema (see
// packages/schema/src/pty.ts) so the generated SDK carries it; reuse that schema verbatim here.
export const Info = Pty.Info
export type Info = Types.DeepMutable<typeof Info.Type>

export const CreateInput = Pty.CreateInput

export type CreateInput = Types.DeepMutable<typeof CreateInput.Type>

export const UpdateInput = Schema.Struct({
  ...Pty.UpdateInput.fields,
  sessionID: Schema.optional(Schema.NullOr(SessionSchema.ID)), // kilocode_change
})

export type UpdateInput = Types.DeepMutable<typeof UpdateInput.Type>

// kilocode_change - the shared events already carry Kilo's extended Info (see packages/schema/src/pty.ts),
// so reuse them verbatim instead of redefining pty.created/pty.updated here.
export const Event = Pty.Event

export type AttachInput = {
  // Absolute output cursor to replay from. -1 tails from the current end; omitted replays the full retained buffer.
  readonly cursor?: number
  // Callbacks fire synchronously from the native PTY data path; keep them non-blocking.
  readonly onData: (chunk: string) => void
  // Fired once when the session stops producing output: process exit (exitCode set), removal, or service teardown.
  readonly onEnd: (event: { exitCode?: number }) => void
  // Canonical routes can replay retained output after exit; legacy callers retain the former error.
  readonly allowExited?: boolean // kilocode_change
}

export type Attachment = {
  // Retained output from the requested cursor to the current end.
  readonly replay: string
  // kilocode_change start - explicit evidence that an older requested cursor lost output to retention.
  readonly replayGap?: { readonly requestedCursor: number; readonly retainedFrom: number; readonly retainedTo: number }
  // kilocode_change end
  // Absolute output cursor after replay.
  readonly cursor: number
  readonly write: (data: string) => void
  // Starts live delivery after the caller has applied replay and cursor metadata.
  readonly activate: () => void
  readonly detach: () => void
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Pty.NotFoundError", {
  ptyID: PtyID,
}) {}

export class ExitedError extends Schema.TaggedErrorClass<ExitedError>()("Pty.ExitedError", {
  ptyID: PtyID,
}) {}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: PtyID) => Effect.Effect<Info, NotFoundError>
  readonly create: (input: CreateInput) => Effect.Effect<Info>
  readonly update: (id: PtyID, input: UpdateInput) => Effect.Effect<Info, NotFoundError>
  readonly remove: (id: PtyID) => Effect.Effect<void, NotFoundError>
  readonly removeDirectory: (location: Location.Ref) => Effect.Effect<void> // kilocode_change
  readonly stopOwner: (sessionID: string) => Effect.Effect<void> // kilocode_change
  readonly write: (id: PtyID, data: string) => Effect.Effect<void, NotFoundError>
  readonly attach: (id: PtyID, input: AttachInput) => Effect.Effect<Attachment, NotFoundError | ExitedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Pty") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const config = yield* Config.Service
    const lifecycle = yield* KiloPtyLifecycle.Service // kilocode_change
    const context = yield* Effect.context()
    const runFork = Effect.runForkWith(context)
    const sessions = KiloPtyRegistry.sessions // kilocode_change

    function notifyEnd(session: Active, event: { exitCode?: number }) {
      for (const subscriber of session.subscribers.values()) {
        if (!subscriber.active) {
          subscriber.end = event
          continue
        }
        try {
          subscriber.onEnd(event)
        } catch (error) {
          Effect.runSync(Effect.logDebug("PTY subscriber end callback failed", { id: session.info.id, error }))
        }
      }
      session.subscribers.clear()
    }

    const requireSession = Effect.fn("Pty.requireSession")(function* (id: PtyID) {
      const session = sessions.get(id)
      const owner = Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID })
      if (!session || !KiloPtyRegistry.sameLocation(session.location, owner))
        return yield* new NotFoundError({ ptyID: id })
      return session
    })

    const removeSession = Effect.fnUntraced(function* (id: PtyID) {
      // kilocode_change start - removal and its deleted event are one uninterruptible lifecycle transition.
      const session = sessions.get(id)
      if (!session || !KiloPtyRegistry.claimRemoval(id)) return
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* Effect.logInfo("removing session", { id })
          yield* Effect.promise(() => KiloPtyRegistry.teardown(session))
          sessions.delete(id)
          KiloPtyRegistry.removeExited(session)
          yield* events
            .publish(Event.Deleted, { id: session.info.id }, { location: session.location })
            .pipe(Effect.catch((error) => Effect.logWarning("failed to publish PTY deleted event", { id, error })))
        }).pipe(Effect.ensuring(Effect.sync(() => KiloPtyRegistry.releaseRemoval(id)))),
      )
      // kilocode_change end
    })

    const remove = Effect.fn("Pty.remove")(function* (id: PtyID) {
      yield* requireSession(id)
      yield* removeSession(id)
    })

    // kilocode_change start - attempt every exact actor before propagating any drainage failure.
    const drain = Effect.fn("Pty.drain")(function* (owned: KiloPtyRegistry.Active[]) {
      const results = yield* Effect.forEach(owned, (session) => Effect.exit(removeSession(session.info.id)), {
        concurrency: 4,
      })
      for (const result of results) {
        if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause)
      }
    })
    // kilocode_change end

    const removeDirectory = Effect.fn("Pty.removeDirectory")(function* (target: Location.Ref) {
      const owned = Array.from(sessions.values()).filter(
        (session) =>
          KiloPtyRegistry.sameDirectory(session.location.directory, target.directory) &&
          session.location.workspaceID === target.workspaceID,
      )
      yield* drain(owned) // kilocode_change
    })

    // kilocode_change start - drain only immutable creation owners in this exact location.
    const stopOwner = Effect.fn("Pty.stopOwner")(function* (sessionID: string) {
      const owner = Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID })
      const owned = Array.from(sessions.values()).filter(
        (session) =>
          session.authority?.ownerSessionID === sessionID && KiloPtyRegistry.sameLocation(session.location, owner),
      )
      yield* drain(owned)
    })
    // kilocode_change end

    const list = Effect.fn("Pty.list")(function* () {
      const owner = Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID })
      return Array.from(sessions.values())
        .filter((session) => KiloPtyRegistry.sameLocation(session.location, owner))
        .map((session) => session.info)
    })

    const get = Effect.fn("Pty.get")(function* (id: PtyID) {
      return (yield* requireSession(id)).info
    })

    const createBody = Effect.fn("Pty.createBody")(function* (input: CreateInput, owner: Location.Ref) {
      const id = PtyID.ascending()
      // kilocode_change start - resolve Kilo self-commands to the real binary, arguments, and project cwd
      const resolved = KiloPtySelfCommand.resolve({
        command: input.command,
        args: input.args ? [...input.args] : undefined,
        cwd: input.cwd,
      })
      const implicit = !resolved.command
      const command = resolved.command || Shell.preferred(Config.latest(yield* config.entries(), "shell"))
      const base = resolved.args ?? []
      const args = implicit && Shell.login(command) ? [...base, "-l"] : [...base]
      const cwd = resolved.cwd || location.directory
      // kilocode_change end
      const env = {
        ...process.env,
        ...input.env,
        TERM: "xterm-256color",
        KILO_TERMINAL: "1",
        KILO_PTY_ID: id, // kilocode_change - let nested Kilo processes identify their parent terminal
      } as Record<string, string>
      // kilocode_change start - do not expose local server credentials to user terminals.
      // node-pty inherits parent values for omitted keys, so empty tombstones are required.
      env.RAYA_SERVER_PASSWORD = ""
      env.RAYA_SERVER_USERNAME = ""
      env.KILO_SERVER_PASSWORD = ""
      env.KILO_SERVER_USERNAME = ""
      // kilocode_change end
      if (process.platform === "win32") {
        env.LC_ALL = "C.UTF-8"
        env.LC_CTYPE = "C.UTF-8"
        env.LANG = "C.UTF-8"
      }
      // kilocode_change start - the adapter fence spans suspended spawn, registry publication and resume.
      const authority = Object.freeze({
        version: 1 as const,
        id,
        location: owner,
        cwd,
        ownerSessionID: input.ownerSessionID,
      })
      const native = process.platform === "win32" && NativeProcess.mode() === "native"
      const launch = (lease?: Lease) => {
        const release = lease ? KiloPtyRegistry.beginCreate(owner) : () => undefined
        return Effect.gen(function* () {
          const contained = lease
            ? yield* Effect.promise(() => NativePty.prepare({ command, args, cwd, env }, lease, context))
            : undefined
          // kilocode_change end
          yield* Effect.logInfo("creating session", { id, cmd: command, args, cwd })
          const { spawn } = yield* Effect.promise(() => pty())
          if (lease) yield* lease.dispatch() // kilocode_change
          // kilocode_change start - spawn with initial terminal dimensions
          const proc = yield* Effect.sync(() =>
            spawn(contained?.spec.command ?? command, contained?.spec.args ?? args, {
              // kilocode_change
              name: "xterm-256color",
              cwd,
              env: contained?.spec.env ?? env, // kilocode_change
              cols: input.size?.cols,
              rows: input.size?.rows,
            }),
          )
          // kilocode_change end
          const info: Info = {
            id,
            title: input.title || `Terminal ${id.slice(-4)}`,
            command,
            args,
            cwd,
            status: "running",
            pid: proc.pid,
          }
          const session: Active = {
            info,
            location: owner, // kilocode_change
            authority, // kilocode_change
            containment: contained, // kilocode_change
            process: proc,
            buffer: new KiloPtyReplay(BUFFER_LIMIT), // kilocode_change
            bufferCursor: 0,
            cursor: 0,
            subscribers: new Map(),
            listeners: [],
            stopping: false, // kilocode_change
            terminated: false,
          }
          sessions.set(id, session)
          contained?.bind(proc) // kilocode_change
          session.listeners.push(
            proc.onData((chunk) => {
              session.cursor += chunk.length
              for (const [token, subscriber] of session.subscribers.entries()) {
                if (!subscriber.active) {
                  subscriber.pending.push(chunk)
                  continue
                }
                try {
                  subscriber.onData(chunk)
                } catch {
                  session.subscribers.delete(token)
                }
              }
              session.bufferCursor += session.buffer.append(chunk) // kilocode_change - bounded segments avoid whole-tail copying
            }),
            proc.onExit(({ exitCode }) => {
              // kilocode_change start - helper exit alone never proves descendant drain.
              contained?.exit()
              const exited = (result: { exitCode?: number }) => {
                const code = result.exitCode
                // kilocode_change end
                if (session.info.status === "exited") return
                if (session.stopping) {
                  session.info.status = "exited"
                  session.info.exitCode = code // kilocode_change
                  return
                }
                session.info.status = "exited"
                session.info.exitCode = code // kilocode_change
                notifyEnd(session, { exitCode: code }) // kilocode_change
                KiloPtyRegistry.markExited(session)
                runFork(
                  Effect.gen(function* () {
                    yield* Effect.logInfo("session exited", { id, exitCode: code }) // kilocode_change
                    // kilocode_change start - keep distinct event schemas in separate typed branches.
                    if (typeof code === "number") {
                      yield* events
                        .publish(Event.Exited, { id, exitCode: code }, { location: session.location })
                        .pipe(
                          Effect.catch((error) =>
                            Effect.logWarning("failed to publish PTY exited event", { id, error }),
                          ),
                        )
                    }
                    if (typeof code !== "number") {
                      yield* events
                        .publish(Event.Updated, { info: session.info }, { location: session.location })
                        .pipe(
                          Effect.catch((error) =>
                            Effect.logWarning("failed to publish PTY exited event", { id, error }),
                          ),
                        )
                    }
                    // kilocode_change end
                    while (KiloPtyRegistry.exitedCount(session.location) > EXITED_LIMIT) {
                      const oldest = KiloPtyRegistry.oldestExited(session.location)
                      if (!oldest) break
                      yield* removeSession(oldest)
                      if (sessions.has(oldest)) break
                      KiloPtyRegistry.removeExitedID(session.location, oldest)
                    }
                  }),
                )
                // kilocode_change start
              }
              if (contained) {
                runFork(
                  Effect.promise(() => contained.finish()).pipe(
                    Effect.tap((result) => Effect.sync(() => contained.deliver(() => exited(result)))),
                    Effect.catchCause((cause) => Effect.logWarning("native PTY exit remains unknown", { id, cause })),
                  ),
                )
                return
              }
              exited({ exitCode })
              // kilocode_change end
            }),
          )
          // kilocode_change start - all native listeners and immutable ownership exist before target admission.
          if (contained && lease) {
            const identity = yield* Effect.promise((signal) => contained.start(signal))
            info.pid = identity.pid
          }
          // kilocode_change end
          yield* events
            .publish(Event.Created, { info }, { location: session.location })
            .pipe(Effect.catch((error) => Effect.logWarning("failed to publish PTY created event", { id, error })))
          contained?.publish() // kilocode_change
          return info
          // kilocode_change start
        }).pipe(
          Effect.ensuring(Effect.sync(release)),
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (!Exit.isFailure(exit)) return
              const session = sessions.get(id)
              session?.containment?.abandon(() => {
                runFork(removeSession(id))
              })
            }),
          ),
        )
      }
      return yield* native ? lifecycle.admission(authority, (lease) => launch(lease)) : launch()
      // kilocode_change end
    })

    const create = Effect.fn("Pty.create")(function* (input: CreateInput) {
      const owner = Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID })
      if (process.platform === "win32" && NativeProcess.mode() === "native") return yield* createBody(input, owner) // kilocode_change
      const release = KiloPtyRegistry.beginCreate(owner)
      return yield* createBody(input, owner).pipe(Effect.ensuring(Effect.sync(release)))
    })

    const update = Effect.fn("Pty.update")(function* (id: PtyID, input: UpdateInput) {
      const session = yield* requireSession(id)
      if (input.title) session.info.title = input.title
      // kilocode_change start - associate nested Kilo TUI terminals with the viewed session
      if ("sessionID" in input) session.info.sessionID = input.sessionID ?? undefined
      // kilocode_change end
      if (input.size && session.info.status === "running" && (!session.containment || session.containment.writable))
        session.process.resize(input.size.cols, input.size.rows) // kilocode_change
      yield* events.publish(Event.Updated, { info: session.info }, { location: session.location })
      return session.info
    })

    const write = Effect.fn("Pty.write")(function* (id: PtyID, data: string) {
      const session = yield* requireSession(id)
      if (session.info.status === "running" && (!session.containment || session.containment.writable))
        session.process.write(data) // kilocode_change
    })

    const attach = Effect.fn("Pty.attach")(function* (id: PtyID, input: AttachInput) {
      const session = yield* requireSession(id)
      if (session.info.status !== "running" && !input.allowExited) return yield* new ExitedError({ ptyID: id }) // kilocode_change
      yield* Effect.logInfo("client attached to session", { id, directory: location.directory })
      const token = {}
      const subscriber: Subscriber = {
        onData: input.onData,
        onEnd: input.onEnd,
        active: false,
        detached: false,
        pending: [],
        end: session.info.status === "exited" ? { exitCode: session.info.exitCode } : undefined, // kilocode_change
      }
      session.subscribers.set(token, subscriber)
      const start = session.bufferCursor
      const end = session.cursor
      const from =
        input.cursor === -1
          ? end
          : typeof input.cursor === "number" && Number.isSafeInteger(input.cursor)
            ? Math.max(0, input.cursor)
            : 0
      // kilocode_change start - never present a retention-clamped replay as complete history.
      const replayGap =
        input.cursor !== -1 && from < start
          ? { requestedCursor: from, retainedFrom: start, retainedTo: end }
          : undefined
      // kilocode_change end
      const replay = (() => {
        if (!session.buffer.length || from >= end) return "" // kilocode_change - segmented retention
        const offset = Math.max(0, from - start)
        if (offset >= session.buffer.length) return ""
        return session.buffer.slice(offset)
      })()
      return {
        replay,
        ...(replayGap ? { replayGap } : {}), // kilocode_change
        cursor: end,
        write: (data: string) => {
          if (session.info.status === "running" && (!session.containment || session.containment.writable))
            session.process.write(data) // kilocode_change
        },
        activate: () => {
          if (subscriber.active || subscriber.detached) return
          subscriber.active = true
          try {
            for (const chunk of subscriber.pending) subscriber.onData(chunk)
            subscriber.pending.length = 0
            if (subscriber.end) subscriber.onEnd(subscriber.end)
          } catch {
            session.subscribers.delete(token)
          }
        },
        detach: () => {
          subscriber.detached = true
          subscriber.pending.length = 0
          subscriber.end = undefined
          session.subscribers.delete(token)
        },
      }
    })

    return Service.of({ list, get, create, update, remove, removeDirectory, stopOwner, write, attach }) // kilocode_change
  }),
)

export const locationLayer = layer.pipe(Layer.provide(Config.locationLayer), Layer.provide(KiloPtyLifecycle.layer)) // kilocode_change

export const shutdown = KiloPtyRegistry.shutdown // kilocode_change
export const terminateDirectory = KiloPtyRegistry.terminateDirectory // kilocode_change

export const shutdownNode = makeGlobalNode({
  name: "pty-shutdown",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const release = yield* Effect.promise(() => KiloPtyRegistry.acquireOwner())
      yield* Effect.addFinalizer(() =>
        Effect.promise(release).pipe(Effect.catch((error) => Effect.logError("failed to shut down PTYs", { error }))),
      )
    }),
  ),
  deps: [],
}) // kilocode_change

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [EventV2.node, Location.node, Config.node, KiloPtyLifecycle.node],
}) // kilocode_change
