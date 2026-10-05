import { AppLayer } from "@/effect/app-runtime"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { Cause, Effect, Exit, Layer, Scope } from "effect"
import { HttpEffect, HttpMiddleware, HttpServerResponse } from "effect/unstable/http"

/** Join accepted HTTP handler work; streamed/background execution remains owned by its runtime. */
export function admission() {
  let closed = false
  let active = 0
  let pending: Promise<void> | undefined
  let resolve: (() => void) | undefined
  const release = (ticket: { live: boolean } | undefined) => {
    if (!ticket?.live) return
    ticket.live = false
    active -= 1
    if (!active) resolve?.()
  }
  const middleware = HttpMiddleware.make(<E, R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        if (closed) return undefined
        active += 1
        return { live: true }
      }),
      (ticket) =>
        ticket
          ? HttpEffect.appendPreResponseHandler((_request, response) =>
              Effect.sync(() => {
                // The middleware also encloses transport: a live SSE must not block instance disposal.
                // Its original transport scope remains joined by listener shutdown after handler admission drains.
                release(ticket)
                return response
              }),
            ).pipe(Effect.andThen(effect))
          : Effect.succeed(HttpServerResponse.text("Server is shutting down", { status: 503 })),
      (ticket) => Effect.sync(() => release(ticket)),
    ),
  )
  return {
    middleware,
    quiesce(this: void) {
      closed = true
      return (pending ??= active
        ? new Promise<void>((done) => {
            resolve = done
          })
        : Promise.resolve())
    },
  }
}

export function build<A, E, R>(layer: Layer.Layer<A, E, R>, scope: Scope.Scope) {
  // Keep listener transport state fresh while AppLayer reuses the process-wide services.
  return Layer.buildWithMemoMap(Layer.fresh(layer).pipe(Layer.provide(AppLayer)), memoMap, scope)
}

export function stop(input: {
  scope: Scope.Scope
  unpublish: Effect.Effect<void>
  force: Effect.Effect<void>[]
  pty: Effect.Effect<void>
  clear: Effect.Effect<void>
}) {
  return Effect.gen(function* () {
    const failures: Cause.Cause<never>[] = []
    const stage = (effect: Effect.Effect<void>) =>
      Effect.cached(
        effect.pipe(
          Effect.exit,
          Effect.tap((exit) => {
            if (Exit.isFailure(exit)) failures.push(exit.cause)
            return Effect.void
          }),
        ),
      )
    const unpublish = yield* stage(input.unpublish)
    const force = yield* Effect.forEach(input.force, stage)
    const pty = yield* stage(input.pty)
    const close = yield* stage(Scope.close(input.scope, Exit.void).pipe(Effect.ensuring(input.clear)))
    return (forced?: boolean) =>
      Effect.gen(function* () {
        yield* unpublish
        if (forced) {
          yield* Effect.all(force, { concurrency: "unbounded", discard: true })
          yield* pty
        }
        yield* close
        if (failures.length) yield* Effect.failCause(failures.reduce((first, next) => Cause.combine(first, next)))
      }).pipe(Effect.uninterruptible)
  })
}
