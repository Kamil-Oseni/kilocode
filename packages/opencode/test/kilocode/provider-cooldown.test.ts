import { describe, expect } from "bun:test"
import { Effect, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { ProviderCooldown } from "@/kilocode/provider/cooldown"
import { it } from "../lib/effect"

describe("Raya provider cooldown", () => {
  it.effect("keeps the longest window and releases queued work at expiry", () =>
    Effect.gen(function* () {
      const provider = "provider-a"
      ProviderCooldown.clear(provider)
      yield* TestClock.setTime(1_000)

      expect(ProviderCooldown.block(provider, 1_100)).toBe(1_100)
      expect(ProviderCooldown.block(provider, 1_050)).toBe(1_100)
      expect(ProviderCooldown.remaining(provider, 1_000)).toBe(100)

      let released = false
      const fiber = yield* ProviderCooldown.wait(provider).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            released = true
          }),
        ),
        Effect.as("released"),
        Effect.forkChild,
      )
      yield* TestClock.adjust(99)
      expect(released).toBe(false)
      expect(ProviderCooldown.block(provider, 1_200)).toBe(1_200)
      yield* TestClock.adjust(1)
      expect(released).toBe(false)
      yield* TestClock.adjust(100)
      expect(yield* Fiber.join(fiber)).toBe("released")
      expect(ProviderCooldown.remaining(provider, 1_200)).toBe(0)
    }),
  )
})
