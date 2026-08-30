// raya_change - owner "lock a standard design system" flag consulted by UI/design prompts
import { Effect, Schema } from "effect"
import { Storage } from "@/storage/storage"

export namespace RayaDesignSystem {
  export const Info = Schema.Struct({
    locked: Schema.Boolean,
    source: Schema.optional(Schema.String),
  })
  export type Info = typeof Info.Type

  export const SetPayload = Schema.Struct({
    locked: Schema.Boolean,
    source: Schema.optional(Schema.String),
  })

  const DEFAULT: Info = { locked: false }
  const key = ["raya", "design-system", "lock"]
  const decode = Schema.decodeUnknownEffect(Info)

  type Store = Pick<Storage.Interface, "read" | "write">

  // Process cache so the prompt path can read the current lock synchronously
  // (the session loop runs with R = never and can't yield Storage.Service).
  // The extension pushes the setting via `set` on activation and on change, and
  // `get` refreshes it, so this stays current for the active workspace. Defaults
  // to unlocked until the first read, which is the safe posture.
  let cached: Info = DEFAULT

  // Synchronous current lock state for prompt injection. See `cached` above.
  export function current(): Info {
    return cached
  }

  // Reminder injected into prompts while the lock is on. Returns undefined when
  // unlocked so the caller can skip injecting anything (a pure no-op by default).
  export function reminder(info: Info): string | undefined {
    if (!info.locked) return undefined
    const where = info.source?.trim()
    const src = where ? ` The approved system is defined at \`${where}\`.` : ""
    return [
      "<system-reminder>",
      "## Design System Lock",
      "This workspace has an owner-approved design system lock enabled. When generating or modifying any UI, build strictly against the approved design system: reuse its existing components, tokens, spacing, and styles instead of inventing new ones." +
        src,
      "Do not introduce a competing design language or ad-hoc styles that bypass the approved system.",
      "</system-reminder>",
    ].join("\n")
  }

  export function make(deps: { storage: Store }) {
    const get = Effect.fn("RayaDesignSystem.get")(function* () {
      const raw = yield* deps.storage.read<unknown>(key).pipe(
        Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(DEFAULT)),
        Effect.orDie,
      )
      const info = yield* decode(raw).pipe(Effect.orDie)
      cached = info
      return info
    })

    const set = Effect.fn("RayaDesignSystem.set")(function* (info: Info) {
      yield* deps.storage.write(key, info).pipe(Effect.orDie)
      cached = info
      return info
    })

    return { get, set }
  }
}
