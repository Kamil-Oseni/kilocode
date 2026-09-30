import { Duration, Effect } from "effect"
import * as Socket from "effect/unstable/socket/Socket"

// Socket.writer only requests the close handshake. Keep its scoped reader alive
// until the peer closes; the surrounding race interrupts this deadline normally.
export function drain<E, R, E2, R2>(
  take: Effect.Effect<string | Uint8Array | Socket.CloseEvent, E, R>,
  write: (item: string | Uint8Array | Socket.CloseEvent) => Effect.Effect<void, E2, R2>,
  duration: Duration.Input = "5 seconds",
) {
  return Effect.gen(function* () {
    while (true) {
      const item = yield* take
      yield* write(item)
      if (item instanceof Socket.CloseEvent)
        return yield* Effect.never.pipe(Effect.timeoutOption(duration), Effect.asVoid)
    }
  })
}
