import path from "node:path"
import { Effect } from "effect"
import { SnapshotPin } from "./pin"
import type { SnapshotRuntime } from "./runtime"

/** Existing source repositories retain a physical generation across all calls through a port. */
export namespace SnapshotSource {
  export type Ownership = Pick<ReturnType<typeof SnapshotRuntime.install>, "run" | "observe" | "failed">
  export interface Input {
    readonly ownership?: Ownership
  }
  const ports = new WeakMap<Ownership, Map<string, ReturnType<typeof SnapshotPin.make>>>()

  export function run<A, E, R>(input: Input, dir: string, body: Effect.Effect<A, E, R>) {
    if (!input.ownership) return body
    const selected = path.resolve(dir)
    const key = process.platform === "win32" ? selected.toLowerCase() : selected
    const pins = ports.get(input.ownership) ?? new Map<string, ReturnType<typeof SnapshotPin.make>>()
    ports.set(input.ownership, pins)
    const pin = pins.get(key) ?? SnapshotPin.make(selected)
    pins.set(key, pin)
    return pin.run(input.ownership, body)
  }

  export function observe<A, E, R>(input: Input, body: Effect.Effect<A, E, R>) {
    return input.ownership ? input.ownership.observe(body) : body
  }

  export function write<A extends { readonly code: number }, E, R>(input: Input, body: Effect.Effect<A, E, R>) {
    return observe(input, body).pipe(
      Effect.tap((result) => {
        return result.code !== 0 && input.ownership
          ? input.ownership.failed(new Error("Snapshot Git mutation refused"))
          : Effect.void
      }),
    )
  }
}
