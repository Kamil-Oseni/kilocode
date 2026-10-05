import { createHash } from "node:crypto"
import path from "node:path"
import z from "zod"
import { artifacts, collect, type Artifacts } from "./profile-artifacts"
import { assertWorking, inventory, type Working } from "./profile-image"
import { artifactUsage, namespaceID } from "./profile-secondary-schema"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value) && !/[\0\r\n]/.test(value))
const relative = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => !/[\\:\0\r\n]/.test(value) && value.split("/").every((part) => part && part !== "." && part !== ".."),
  )
const selector = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("repository"), id: digest, path: relative }).strict(),
  z.object({ kind: z.literal("primary-working"), id: digest, path: relative }).strict(),
  z.object({ kind: z.literal("worktree"), workspace: absolute, common: digest, path: relative }).strict(),
])
export const git = z
  .object({
    kind: z.literal("git-bytes"),
    namespace: z.union([z.literal("primary"), digest]),
    componentDigest: digest,
    selector,
    source: absolute,
    dev: z.string().regex(/^\d+$/),
    ino: z.string().regex(/^\d+$/),
    bytes: z
      .number()
      .int()
      .safe()
      .nonnegative()
      .max(32 * 1024 * 1024),
    digest,
    activation: z.literal("inert"),
  })
  .strict()
export type GitComponents = Readonly<{
  artifacts?: Artifacts
  secondary?: Readonly<{ namespaces: readonly Readonly<{ id: string; artifacts?: Artifacts }>[] }>
}>
const key = (value: string) => (process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value))
const excluded = (section: z.output<typeof selector>, file: string) =>
  (section.kind === "repository" && ["config", "config.worktree"].includes(file.toLowerCase())) ||
  file.split("/").some((part) => part.toLowerCase() === ".git")
function resolve(value: Artifacts, selected: z.output<typeof selector>) {
  if (excluded(selected, selected.path)) throw new Error("Git projection or control bytes lack exact correspondence")
  if (selected.kind === "worktree") {
    const tree = value.worktrees.filter(
      (tree) => key(tree.workspace) === key(selected.workspace) && tree.common === selected.common,
    )
    if (tree.length !== 1) throw new Error("Git worktree selector is ambiguous or missing")
    return { source: path.join(tree[0].workspace, ...selected.path.split("/")), entries: tree[0].files }
  }
  const repositories = value.repositories.filter((item) => item.id === selected.id)
  if (repositories.length !== 1) throw new Error("Git repository selector is ambiguous or missing")
  const repository = repositories[0]
  if (selected.kind === "repository")
    return { source: path.join(repository.source, ...selected.path.split("/")), entries: repository.files }
  if (!repository.workspace || !repository.working) throw new Error("Git primary working component is missing")
  return { source: path.join(repository.workspace, ...selected.path.split("/")), entries: repository.working.files }
}
function component(input: GitComponents, namespace: string) {
  if (namespace === "primary") {
    if (!input.artifacts) throw new Error("Git primary component is missing")
    return artifacts.parse(input.artifacts)
  }
  const matches = input.secondary?.namespaces.filter((item) => item.id === namespace) ?? []
  if (matches.length !== 1 || !matches[0].artifacts)
    throw new Error("Git secondary namespace selector is ambiguous or missing")
  return artifacts.parse(matches[0].artifacts)
}
export function validateGit(input: z.input<typeof git>, content: GitComponents) {
  const entry = git.parse(input)
  const value = component(content, entry.namespace)
  if (hash(value) !== entry.componentDigest) throw new Error("Git correspondence component differs")
  const selected = resolve(value, entry.selector)
  const files = selected.entries.filter((file) => file.path === entry.selector.path)
  if (files.length !== 1 || key(selected.source) !== key(entry.source))
    throw new Error("Git correspondence exact selector differs")
  const bytes = Buffer.from(files[0].bytes, "base64")
  if (
    files[0].digest !== entry.digest ||
    bytes.length !== entry.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== entry.digest
  )
    throw new Error("Git correspondence decoded bytes differ")
}
const freeze = <T>(value: T): T => {
  if (value === null || typeof value !== "object") return value
  for (const item of Object.values(value)) freeze(item)
  return Object.freeze(value)
}
const brand: unique symbol = Symbol("held-git-correspondence")
export type GitClaim = Readonly<{ [brand]: true }>
const claims = new WeakMap<object, { token: Working; groups: readonly z.output<typeof git>[] }>()
/** Claims exist only for exact decoded codec bytes on the actual live native inventory. */
export async function bindGit(token: Working, input: GitComponents): Promise<GitClaim> {
  const image = assertWorking(token)
  const native = inventory(token)
  const namespaces = [
    ...(input.artifacts ? [{ id: "primary", value: artifacts.parse(input.artifacts) }] : []),
    ...(input.secondary?.namespaces.flatMap((entry) =>
      entry.artifacts ? [{ id: digest.parse(entry.id), value: artifacts.parse(entry.artifacts) }] : [],
    ) ?? []),
  ]
  if (namespaces.length > 129 || new Set(namespaces.map((entry) => entry.id)).size !== namespaces.length)
    throw new Error("Git correspondence namespace inventory differs")
  const usage = namespaces.map((entry) => artifactUsage(entry.value))
  if (
    usage.reduce((sum, item) => sum + item.bytes, 0) > 96 * 1024 * 1024 ||
    usage.reduce((sum, item) => sum + item.nodes, 0) > 20_000 ||
    usage.reduce((sum, item) => sum + item.repositories, 0) > 256 ||
    usage.reduce((sum, item) => sum + item.bindings, 0) > 10_000
  )
    throw new Error("Git correspondence shared inventory exceeds bound")
  const groups: z.output<typeof git>[] = []
  const seen = new Set<string>()
  for (const namespace of namespaces) {
    const roots = image.namespaces.filter((entry) =>
      namespace.id === "primary"
        ? key(entry.staged.data) === key(image.profile.data)
        : namespaceID(entry.original.data, path.join(entry.original.data, "storage")) === namespace.id,
    )
    const sources = [...new Map(roots.map((entry) => [key(entry.original.data), entry.original.data])).values()]
    if (sources.length !== 1) throw new Error("Git correspondence lacks one actual Global data binding")
    const workspaces = [
      ...new Set([
        ...namespace.value.repositories.flatMap((entry) => (entry.workspace ? [entry.workspace] : [])),
        ...namespace.value.worktrees.map((entry) => entry.workspace),
        ...namespace.value.snapshots.map((entry) => entry.workspace),
      ]),
    ]
    const actual = await collect(token, { data: sources[0], workspaces })
    if (hash(actual) !== hash(namespace.value))
      throw new Error("Git correspondence differs from the actual held artifact reader")
    const selected: z.output<typeof selector>[] = [
      ...namespace.value.repositories.flatMap((repository) => [
        ...repository.files.map((file) => ({ kind: "repository" as const, id: repository.id, path: file.path })),
        ...(repository.working?.files.map((file) => ({
          kind: "primary-working" as const,
          id: repository.id,
          path: file.path,
        })) ?? []),
      ]),
      ...namespace.value.worktrees.flatMap((tree) =>
        tree.files.map((file) => ({
          kind: "worktree" as const,
          workspace: tree.workspace,
          common: tree.common,
          path: file.path,
        })),
      ),
    ]
    for (const section of selected) {
      if (excluded(section, section.path)) continue
      const entry = resolve(namespace.value, section)
      const records = native.files.filter((file) => key(file.path) === key(entry.source))
      if (records.length !== 1) throw new Error("Git correspondence lacks one exact native file identity")
      const record = records[0]
      const value = git.parse({
        kind: "git-bytes",
        namespace: namespace.id,
        componentDigest: hash(namespace.value),
        selector: section,
        source: record.path,
        dev: record.dev,
        ino: record.ino,
        bytes: record.bytes,
        digest: record.digest,
        activation: "inert",
      })
      validateGit(value, input)
      const id = `${namespace.id}:${key(record.path)}`
      if (seen.has(id)) throw new Error("Git correspondence duplicates a physical selector")
      seen.add(id)
      groups.push(value)
      if (groups.length > 20_000) throw new Error("Git correspondence inventory exceeds bound")
    }
  }
  inventory(token)
  const claim = Object.freeze({ [brand]: true as const })
  claims.set(claim, { token, groups: freeze(groups) })
  return claim
}
export function gitGroups(token: Working, claim: GitClaim) {
  inventory(token)
  const state = claims.get(claim)
  if (!state || state.token !== token)
    throw new Error("Git correspondence binding is absent or belongs to another image")
  return state.groups
}
