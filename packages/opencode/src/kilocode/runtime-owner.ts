import { RuntimeRegistry } from "@opencode-ai/core/kilocode/runtime-registry"

/** Reset closes one generation; retirement permanently fences lazy acquisition. */
export function runtimeOwner<A extends { dispose(): Promise<void> }>(
  create: () => A,
  settle?: (active: A) => Promise<unknown>,
) {
  let current: A | undefined
  let closing: Promise<void> | undefined
  let retired: Promise<void> | undefined
  let closed = false
  const dispose = (): Promise<void> => {
    if (closing) return closing
    if (!current) return Promise.resolve()
    const active = current
    closing = Promise.resolve()
      .then(async () => {
        // ManagedRuntime closes its layer scope in parallel with the build fiber.
        // Join accepted initialization before native resources can close under it.
        const errors: unknown[] = []
        if (settle) await settle(active).catch((err: unknown) => errors.push(err))
        await active.dispose().catch((err: unknown) => errors.push(err))
        if (errors.length === 1) throw errors[0]
        if (errors.length) throw new AggregateError(errors, "Service runtime retirement failed")
      })
      .then(() => {
        current = undefined
        closing = undefined
      })
    return closing
  }
  const owner = {
    get(this: void): A {
      RuntimeRegistry.check()
      if (closed) throw new Error("Service runtime is retired")
      if (closing) throw new Error("Service runtime is closing")
      return (current ??= create())
    },
    dispose,
    retire(this: void): Promise<void> {
      closed = true
      return (retired ??= dispose())
    },
  }
  RuntimeRegistry.register(owner.retire)
  return owner
}
