const roots = new WeakMap<object, string>()

/** Metadata for this exact live service only; no filesystem or maintenance authority. */
export function bind(service: object, root: string) {
  if (roots.has(service)) throw new Error("Storage selection was already bound")
  roots.set(service, root)
  return () => roots.delete(service)
}

export function selected(service: object) {
  const root = roots.get(service)
  if (!root) throw new Error("Storage selection is unavailable or retired")
  return root
}
