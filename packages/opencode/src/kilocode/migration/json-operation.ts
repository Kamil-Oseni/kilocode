import { acquireProfileRoot, resolveProfileRoot } from "@opencode-ai/core/kilocode/profile-maintenance"
import { Effect } from "effect"

/** Select inside process admission; retain canonical ownership until accepted native work and cleanup settle. */
export function jsonOperation<A>(
  select: () => string,
  body: (root: string) => Promise<A>,
  options: { timeoutMs?: number } = {},
) {
  return Effect.gen(function* () {
    const root = yield* Effect.promise(() => resolveProfileRoot({ kind: "json", path: select() }))
    return yield* Effect.acquireUseRelease(
      Effect.promise((signal) => acquireProfileRoot(root, { ...options, signal })),
      () => Effect.promise(() => body(root.path)).pipe(Effect.uninterruptible),
      (lease) => Effect.promise(() => lease.release()),
    )
  })
}
