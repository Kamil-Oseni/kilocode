// raya_change - share provider rate-limit windows across sessions in one backend process
import { Clock, Duration, Effect } from "effect"

const windows = new Map<string, number>()

export namespace ProviderCooldown {
  export function block(provider: string, until: number) {
    const current = windows.get(provider) ?? 0
    const next = Math.max(current, until)
    windows.set(provider, next)
    return next
  }

  export function remaining(provider: string, now: number) {
    const until = windows.get(provider)
    if (until === undefined) return 0
    const ms = until - now
    if (ms > 0) return ms
    windows.delete(provider)
    return 0
  }

  export function wait(provider: string): Effect.Effect<void> {
    return Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const ms = remaining(provider, now)
      if (ms === 0) return
      yield* Effect.sleep(Duration.millis(ms))
      yield* wait(provider)
    })
  }

  export function clear(provider: string) {
    windows.delete(provider)
  }
}
