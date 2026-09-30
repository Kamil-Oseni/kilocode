/** An outer owner can retire a lazy runtime once; callers cannot reacquire it during or after disposal. */
export function runtimeOwner<A extends { dispose(): Promise<void> }>(create: () => A) {
  let current: A | undefined
  let closing: Promise<void> | undefined
  let closed = false
  return {
    get(): A {
      if (closed) throw new Error("Core service runtime is closed")
      return (current ??= create())
    },
    dispose(): Promise<void> {
      closed = true
      closing ??= Promise.resolve().then(() => current?.dispose())
      return closing
    },
  }
}
