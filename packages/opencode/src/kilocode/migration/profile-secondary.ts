import { createHash } from "node:crypto"
import { lstat, opendir } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { collect, artifacts as schema } from "./profile-artifacts"
import { snapshot } from "./profile-bundle"
import { historical } from "./profile-evidence"
import { assertWorking, lookup, type Working } from "./profile-image"
import { memoryValues, readMemory, type MemoryReader } from "./profile-memory-correspondence"
import { artifactUsage, namespaceID, secondary } from "./profile-secondary-schema"
import { identity } from "./profile-workspaces"

type Artifacts = z.output<typeof schema>
type Snapshot = z.output<typeof snapshot>
const maximum = 128 * 1024 * 1024

/** Canonical object keys make equal independently parsed historical records comparable. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, stable(value)]),
    )
  return value
}

export function unionArchives(groups: readonly (readonly Snapshot[])[]) {
  const records = new Map<string, { digest: string; value: Snapshot }>()
  for (const group of groups)
    for (const input of group) {
      const value = snapshot.parse(input)
      const digest = createHash("sha256")
        .update(JSON.stringify(stable(value)))
        .digest("hex")
      const prior = records.get(value.id)
      if (prior && prior.digest !== digest) throw new Error("Historical source identity has conflicting content")
      if (!prior) records.set(value.id, { digest, value })
      if (records.size > 64) throw new Error("Historical source inventory exceeds its shared bound")
    }
  return [...records.values()].map((item) => item.value)
}

/** Only authenticated, exact Global data mappings on the live image may supply secondary content. */
export async function collectSecondary(
  token: Working,
  primary: string,
  workspaces: readonly string[],
  initial: Artifacts | undefined,
  archives: readonly Snapshot[],
) {
  const image = assertWorking(token)
  if (identity(lookup(token, primary)) !== identity(image.profile.data))
    throw new Error("Secondary collection primary differs from the selected held data namespace")
  const namespaces = [
    ...new Map(
      image.namespaces
        .filter((item) => identity(item.original.data) !== identity(primary))
        .map((item) => [identity(item.original.data), item]),
    ).values(),
  ]
  const groups: Snapshot[][] = [archives.slice()]
  const values: z.output<typeof secondary>["namespaces"] = []
  const readers: MemoryReader[] = []
  const size = artifactUsage(initial)
  await boundData(token, image.profile.data)
  for (const item of namespaces) {
    assertWorking(token)
    const reader = await readMemory(token, item.original.data)
    const memory = memoryValues(token, reader)
    readers.push(reader)
    if (memory.some((item) => !workspaces.some((workspace) => identity(workspace) === identity(item.workspace))))
      throw new Error("Secondary memory workspace lacks an authenticated held workspace mapping")
    const history = await historical(item.staged.data)
    groups.push(history)
    const artifacts = await collect(
      token,
      { data: item.original.data, workspaces: [...workspaces] },
      {
        bytes: 96 * 1024 * 1024 - size.bytes,
        nodes: 20_000 - size.nodes,
      },
    )
    const used = artifactUsage(artifacts)
    size.bytes += used.bytes
    size.nodes += used.nodes
    size.repositories += used.repositories
    size.bindings += used.bindings
    if (size.bytes > 96 * 1024 * 1024 || size.nodes > 20_000 || size.repositories > 256 || size.bindings > 10_000)
      throw new Error("Git artifacts exceed their shared namespace inventory bound")
    values.push({
      id: namespaceID(item.original.data, path.join(item.original.data, "storage")),
      source: { data: item.original.data, storage: path.join(item.original.data, "storage") },
      memory,
      artifacts,
      archives: history.map((item) => item.id),
    })
  }
  return Object.defineProperty(
    {
      readers,
      archives: unionArchives(groups),
      secondary: values.length
        ? secondary.parse({
            format: "raya.secondary-data",
            version: 1,
            namespaces: values,
            reviewOnly: true,
            activation: "held",
            coverage: "declared-secondary-data",
            completeProfileCoverage: false,
            portableCaptureAuthorized: false,
          })
        : undefined,
    },
    "readers",
    { enumerable: false },
  )
}

/** Bound every selected known memory/archive inventory before loading its bodies. */
export async function boundData(token: Working, primary: string) {
  const image = assertWorking(token)
  if (identity(primary) !== identity(image.profile.data))
    throw new Error("Known data preflight requires the selected private image namespace")
  const directories = [...new Set([primary, ...image.namespaces.map((item) => item.staged.data)])]
  const files = { bytes: 0, nodes: 0 }
  async function preflight(file: string, depth = 0): Promise<void> {
    assertWorking(token)
    const stat = await lstat(file).catch((err: unknown) => {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined
      throw err
    })
    if (!stat) return
    if (++files.nodes > 20_000 || depth > 64) throw new Error("Secondary data exceeds its shared node bound")
    if (stat.isSymbolicLink()) throw new Error("Secondary data contains an unverified symbolic link")
    if (stat.isDirectory()) {
      for await (const entry of await opendir(file)) await preflight(path.join(file, entry.name), depth + 1)
      return
    }
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Secondary data contains an unsupported file")
    files.bytes += stat.size
    if (files.bytes > maximum) throw new Error("Secondary data exceeds its shared byte bound")
  }
  // Bound all known memory/archive source files before reading any of their bodies.
  for (const directory of directories) {
    await preflight(path.join(directory, "memory"))
    await preflight(path.join(directory, "restore-source.json"))
  }
}
