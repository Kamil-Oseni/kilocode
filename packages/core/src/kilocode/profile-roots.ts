import path from "node:path"

type Root = Readonly<{ kind: "sqlite" | "json"; path: string }>

/** Records supplied canonical admission metadata only; never resolves or realizes a profile. */
export function createInventory() {
  const roots = new Map<string, Root>()
  return {
    register(root: Root): void {
      if ((root.kind !== "sqlite" && root.kind !== "json") || !path.isAbsolute(root.path))
        throw new Error("Profile inventory requires an admitted absolute canonical root")
      const file = path.normalize(root.path)
      const key = `${root.kind}:${process.platform === "win32" ? file.toLowerCase() : file}`
      if (!roots.has(key)) roots.set(key, Object.freeze({ kind: root.kind, path: file }))
    },
    snapshot(): readonly Root[] {
      return Object.freeze([...roots.keys()].sort().map((key) => Object.freeze({ ...roots.get(key)! })))
    },
  }
}

export const ProfileRoots = createInventory()
