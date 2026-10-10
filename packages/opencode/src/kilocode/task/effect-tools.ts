import { Effect } from "effect"
import type { EffectBridge } from "@/effect/bridge"
import { RayaTask } from "."
import * as Lineage from "./effect-lineage"

/** Preserve the original catalog owner across actual tool callback fibers. */
export function bridge(base: EffectBridge.Shape, session: string, routine: boolean) {
  return Effect.gen(function* () {
    const owner = yield* Lineage.bind()
    if (routine && !owner)
      return yield* Effect.die(
        new RayaTask.GuardError({
          message: "This routine's tool catalog has no original execution owner.",
        }),
      )
    return {
      ...base,
      promise: <A, E, R>(body: Effect.Effect<A, E, R>) =>
        Lineage.run(owner, () => base.promise(Lineage.callback(session, body))),
    } satisfies EffectBridge.Shape
  })
}
