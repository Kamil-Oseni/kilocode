import { realpath } from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Result } from "effect"
import z from "zod"
import { Global } from "@opencode-ai/core/global"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { composerDrafts, DraftError, DraftSchemas, type DraftIdentity } from "@/kilocode/session/composer-drafts"
import {
  ComposerDraftError,
  type Scope,
  type List,
  type Load,
  type Save,
  type Clear,
  type Promote,
} from "../groups/composer-drafts"

const failure = (code: ComposerDraftError["code"]) =>
  new ComposerDraftError({ code, message: `Composer draft request could not finish: ${code}.` })
const canonical = (dir: string) => (process.platform === "win32" ? dir.toLowerCase() : dir)

/** No arbitrary Storage root or profile-wide snapshot is accepted from a client. */
export function composerHandlers(storage: Storage.Interface, sessions: Session.Interface) {
  const drafts = composerDrafts(storage, path.join(Global.Path.data, "storage"))
  const boundary = <A, E, R>(body: Effect.Effect<A, E, R>) =>
    body.pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterrupts(cause)) return Effect.interrupt
        const err = Result.getOrUndefined(Cause.findError(cause)) ?? Result.getOrUndefined(Cause.findDefect(cause))
        if (err instanceof ComposerDraftError) return Effect.fail(err)
        return Effect.fail(
          failure(err instanceof DraftError ? err.code : err instanceof z.ZodError ? "invalid" : "unavailable"),
        )
      }),
    )
  const scope = (who: typeof Scope.Type) =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const dirs = yield* Effect.tryPromise({
        try: () => Promise.all([realpath(instance.directory), realpath(who.workspace)]),
        catch: () => failure("scope"),
      })
      if (
        canonical(dirs[0]) !== canonical(dirs[1]) ||
        (who.projectID !== undefined && who.projectID !== instance.project.id)
      )
        return yield* failure("scope")
      return { workspace: dirs[0], projectID: instance.project.id, box: who.box }
    })
  const identity = (who: DraftIdentity) =>
    Effect.gen(function* () {
      if (Boolean(who.sessionID) === Boolean(who.pendingID)) return yield* failure("invalid")
      const owner = { ...who, ...(yield* scope(who)) }
      const selected = owner.sessionID
      if (selected) {
        const id = yield* Effect.try({ try: () => SessionID.make(selected), catch: () => failure("scope") })
        const session = yield* sessions.get(id).pipe(Effect.mapError(() => failure("scope")))
        const dir = yield* Effect.tryPromise({ try: () => realpath(session.directory), catch: () => failure("scope") })
        if (session.projectID !== owner.projectID || canonical(dir) !== canonical(owner.workspace))
          return yield* failure("scope")
      }
      return owner
    })
  return {
    list: (ctx: { payload: typeof List.Type }) =>
      boundary(
        Effect.gen(function* () {
          const owner = yield* scope(ctx.payload.scope)
          const data = yield* drafts.snapshot()
          return {
            entries: data.entries.filter(
              (entry) =>
                entry.identity.workspace === owner.workspace &&
                entry.identity.projectID === owner.projectID &&
                entry.identity.box === owner.box,
            ),
          }
        }),
      ),
    load: (ctx: { payload: typeof Load.Type }) =>
      boundary(
        Effect.gen(function* () {
          return {
            entry: (yield* drafts.load(yield* identity(DraftSchemas.identity.parse(ctx.payload.identity)))) ?? null,
          }
        }),
      ),
    save: (ctx: { payload: typeof Save.Type }) =>
      boundary(
        Effect.gen(function* () {
          const who = yield* identity(DraftSchemas.identity.parse(ctx.payload.identity))
          return {
            entry: yield* drafts.save(
              who,
              ctx.payload.expected,
              DraftSchemas.content.parse(ctx.payload.content),
              ctx.payload.mutation,
            ),
          }
        }),
      ),
    clear: (ctx: { payload: typeof Clear.Type }) =>
      boundary(
        Effect.gen(function* () {
          return {
            entry: yield* drafts.clear(
              yield* identity(DraftSchemas.identity.parse(ctx.payload.identity)),
              ctx.payload.expected,
              ctx.payload.mutation,
            ),
          }
        }),
      ),
    promote: (ctx: { payload: typeof Promote.Type }) =>
      boundary(
        Effect.gen(function* () {
          const from = yield* identity(DraftSchemas.identity.parse(ctx.payload.from))
          const to = yield* identity(DraftSchemas.identity.parse(ctx.payload.to))
          if (!from.pendingID || !to.sessionID || from.box !== to.box) return yield* failure("invalid")
          return yield* drafts.promote(from, to, ctx.payload.source, ctx.payload.target, ctx.payload.mutation)
        }),
      ),
  }
}
