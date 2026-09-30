/** Reset closes one generation; retirement permanently fences lazy acquisition. */
export function runtimeOwner<A extends { dispose(): Promise<void> }>(create: () => A) {
  let current: A | undefined
  let closing: Promise<void> | undefined
  let retired: Promise<void> | undefined
  let closed = false
  const dispose = (): Promise<void> => {
    if (closing) return closing
    if (!current) return Promise.resolve()
    const active = current
    closing = Promise.resolve()
      .then(() => active.dispose())
      .then(() => {
        current = undefined
        closing = undefined
      })
    return closing
  }
  return {
    get(this: void): A {
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
}
