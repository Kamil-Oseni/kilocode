import { acquireProfileRoot, resolveProfileRoot } from "@opencode-ai/core/kilocode/profile-maintenance"
import { Context, Effect } from "effect"
import type { ProfileWriterLive } from "./writer-live"

type Owner = { id: string; fiber: unknown; active: boolean }
const Current = Context.Reference<Owner | undefined>("@raya/ProfileJSONWriter", { defaultValue: () => undefined })

/** Keep the registry and cross-process root owned until native JSON effects settle. */
export function storageAdmission(dir: string, admission: ProfileWriterLive.Admission): ProfileWriterLive.Admission {
  return {
    run: (body) =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => resolveProfileRoot({ kind: "json", path: dir }))
        const current = yield* Current
        return yield* Effect.withFiber((fiber) => {
          if (current) {
            if (!current.active || current.fiber !== fiber || current.id !== root.id)
              return Effect.die(new Error("JSON writer admission cannot escape its owning fiber or nest another root"))
            return admission.run(body)
          }
          return Effect.acquireUseRelease(
            Effect.promise((signal) => acquireProfileRoot(root, { signal })),
            (lease) => {
              const owner: Owner = { id: lease.id, fiber, active: true }
              return admission.run(Effect.provideService(body, Current, owner)).pipe(
                Effect.uninterruptible,
                Effect.ensuring(
                  Effect.sync(() => {
                    owner.active = false
                  }),
                ),
              )
            },
            (lease) => Effect.promise(() => lease.release()),
          )
        })
      }),
  }
}
