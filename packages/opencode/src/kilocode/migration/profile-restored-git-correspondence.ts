import { createHash } from "node:crypto"
import path from "node:path"
import { open } from "node:fs/promises"
import type z from "zod"
import {
  artifacts,
  locations,
  renderGitCommon,
  renderGitConfig,
  renderGitLink,
  type Artifacts,
} from "./profile-artifacts"
import type { snapshot } from "./profile-bundle"
import { regular } from "./profile-file"
import { inventory, lookup, type Working } from "./profile-image"
import {
  historicalDigest,
  historicalValues,
  requireHistorical,
  type HistoricalReader,
} from "./profile-restored-evidence"
import { restoredArtifacts, restoredGit } from "./profile-restored-git-schema"
import { identity } from "./profile-workspaces"
import { ReviewSchema, validateReview } from "./profile-restore-review-schema"
import { readReviewContext } from "./profile-restored-components-correspondence"

type Entry = z.output<typeof restoredGit>
export type RestoredGitComponents = Readonly<{ restoredArtifacts?: z.output<typeof restoredArtifacts> }>
const key = (file: string) => (process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file))
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const inert = (file: string) => {
  const name = file.toLowerCase()
  return (
    ["config", "config.worktree", "objects/info/alternates", "info/attributes", "gitdir", "commondir"].includes(name) ||
    name.startsWith("hooks/")
  )
}
async function hashFile(file: string, budget: number) {
  const handle = await open(await regular(file), "r")
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size > Math.min(budget, 32 * 1024 * 1024))
      throw new Error("Restored Git file exceeds bound")
    const hash = createHash("sha256")
    const buffer = Buffer.alloc(65536)
    let size = 0
    while (size <= info.size) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, info.size + 1 - size), size)
      if (!result.bytesRead) break
      size += result.bytesRead
      hash.update(buffer.subarray(0, result.bytesRead))
    }
    if (size !== info.size) throw new Error("Restored Git staged file changed")
    return { bytes: size, digest: hash.digest("hex") }
  } finally {
    await handle.close()
  }
}
function routes(value: Artifacts, data: string, review?: z.output<typeof ReviewSchema>) {
  const roots = locations(
    value,
    data,
    new Map(Object.entries(review?.workspaces ?? {})),
    review?.version === 2 ? review.primaries : [],
  )
  const entries: {
    selector: Entry["selector"]
    source: string
    digest: string
    bytes: number
    relationship: Entry["relationship"]
  }[] = []
  const add = (
    route: Entry["selector"]["route"],
    repository: string,
    file: string,
    root: string,
    bytes: Buffer,
    worktree?: string,
    generated = false,
  ) => {
    if (entries.length >= 20000) throw new Error("Restored Git route inventory exceeds bound")
    entries.push({
      selector: { route, repository, path: file, ...(worktree ? { worktree } : {}) },
      source: path.join(data, "git-artifacts", root, ...file.split("/")),
      digest: sha(bytes),
      bytes: bytes.length,
      relationship: generated ? "materialize-generated" : "archived-bytes",
    })
  }
  for (const repo of value.repositories) {
    const primary =
      review?.version === 2 &&
      repo.workspace &&
      review.primaries.some((source) => identity(source) === identity(repo.workspace!))
        ? Object.entries(review.workspaces).find(([source]) => identity(source) === identity(repo.workspace!))?.[1]
        : undefined
    for (const file of repo.files)
      add(
        inert(file.path) ? "repository-evidence" : "repository-files",
        repo.id,
        file.path,
        `${inert(file.path) ? "evidence" : "repositories"}/${repo.id}`,
        Buffer.from(file.bytes, "base64"),
      )
    add(
      "repository-config",
      repo.id,
      "config",
      `repositories/${repo.id}`,
      renderGitConfig(roots.get(repo.id)!, repo.objectFormat, primary),
      undefined,
      true,
    )
    if (!repo.working) continue
    for (const file of repo.working.files)
      add("primary-tree", repo.id, file.path, `primary-evidence/${repo.id}/tree`, Buffer.from(file.bytes, "base64"))
    add(
      "primary-manifest",
      repo.id,
      "manifest.json",
      `primary-evidence/${repo.id}`,
      Buffer.from(
        JSON.stringify({ version: 1, source: repo.workspace, excluded: repo.working.excluded, active: false }),
      ),
      undefined,
      true,
    )
  }
  for (const item of value.snapshots) {
    const repo = value.repositories.find((repo) => repo.id === item.repository)!
    for (const file of repo.files)
      if (inert(file.path))
        add("snapshot-evidence", repo.id, file.path, `snapshot-evidence/${repo.id}`, Buffer.from(file.bytes, "base64"))
  }
  for (const item of value.worktrees) {
    const id = sha(identity(item.workspace))
    const admin = `repositories/${item.common}/worktrees/${id}`
    for (const file of item.admin)
      add(
        inert(file.path) ? "worktree-evidence" : "worktree-admin",
        item.common,
        file.path,
        inert(file.path) ? `worktree-evidence/${id}` : admin,
        Buffer.from(file.bytes, "base64"),
        id,
      )
    add("worktree-commondir", item.common, "commondir", admin, renderGitCommon(), id, true)
    add(
      "worktree-gitdir",
      item.common,
      "gitdir",
      admin,
      renderGitLink(path.join(data, "worktree", item.project, item.name)),
      id,
      true,
    )
  }
  return entries
}
function component(input: RestoredGitComponents, entry: Entry) {
  const matches = restoredArtifacts
    .parse(input.restoredArtifacts ?? [])
    .filter((item) => item.archive === entry.archive && item.namespace === entry.namespace)
  if (matches.length !== 1 || matches[0].archiveDigest !== entry.archiveDigest)
    throw new Error("Restored Git archive projection is missing or changed")
  const parsed = matches[0].artifacts
  if (historicalDigest(parsed) !== entry.componentDigest) throw new Error("Restored Git artifact component changed")
  return matches[0]
}
export function validateRestoredGit(raw: z.input<typeof restoredGit>, input: RestoredGitComponents) {
  const entry = restoredGit.parse(raw)
  const value = component(input, entry)
  if (value.context && key(value.context.data) !== key(entry.data))
    throw new Error("Restored Git review namespace differs")
  const review = value.context ? ReviewSchema.parse(JSON.parse(value.context.reviewText)) : undefined
  const matches = routes(value.artifacts, entry.data, review).filter(
    (item) => historicalDigest(item.selector) === historicalDigest(entry.selector),
  )
  if (
    !matches.length ||
    matches.some(
      (item) =>
        key(item.source) !== key(entry.source) ||
        item.digest !== entry.digest ||
        item.bytes !== entry.bytes ||
        item.relationship !== entry.relationship,
    )
  )
    throw new Error("Restored Git exact writer bytes or selector changed")
}
export function validateRestoredArtifacts(
  values: z.output<typeof restoredArtifacts>,
  input: Readonly<{ archives: readonly z.output<typeof snapshot>[] }>,
) {
  for (const value of restoredArtifacts.parse(values)) {
    const matches = input.archives.filter((archive) => archive.id === value.archive)
    if (matches.length !== 1 || historicalDigest(matches[0]) !== value.archiveDigest)
      throw new Error("Restored Git original archive differs")
    const archive = matches[0]
    const original =
      value.namespace === "primary"
        ? archive.artifacts
        : archive.secondary?.namespaces.find((scope) => scope.id === value.namespace)?.artifacts
    if (!original || historicalDigest(original) !== historicalDigest(value.artifacts))
      throw new Error("Restored Git original artifact component differs")
    if (value.context) {
      if (value.namespace !== "primary") throw new Error("Secondary Git projection has unexpected primary review")
      validateReview(value.context, archive)
    }
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}
const brand: unique symbol = Symbol("held-restored-git")
export type RestoredGitClaim = Readonly<{ [brand]: true }>
const claims = new WeakMap<
  object,
  { token: Working; groups: readonly Readonly<Entry>[]; values: z.output<typeof restoredArtifacts> }
>()
export async function bindRestoredGit(
  token: Working,
  reader: HistoricalReader,
  input: Readonly<{ archives: readonly z.output<typeof snapshot>[] }>,
): Promise<RestoredGitClaim> {
  requireHistorical(token, reader, input)
  const native = inventory(token)
  const files = new Map(native.files.map((file) => [key(file.path), file]))
  const selected = new Map<string, Readonly<Entry>>()
  const projections = new Map<string, z.output<typeof restoredArtifacts>[number]>()
  const budget = { bytes: 0, routes: 0 }
  const scopes = [...new Map(native.globals.map((scope) => [key(scope.data), scope.data])).values()]
  for (const data of scopes) {
    if (
      !native.roots.some(
        (root) => root.kind === "json" && root.directory && !root.absent && key(root.path) === key(data),
      )
    )
      continue
    for (const archive of historicalValues(token, reader)) {
      const context = await readReviewContext(token, data, archive)
      const groups = [
        ...(archive.artifacts ? [{ id: "primary", value: archive.artifacts }] : []),
        ...(archive.secondary?.namespaces.flatMap((item) =>
          item.artifacts ? [{ id: item.id, value: item.artifacts }] : [],
        ) ?? []),
      ]
      for (const group of groups) {
        const value = artifacts.parse(group.value)
        const linked = group.id === "primary" ? context : undefined
        const expected = routes(value, data, linked ? validateReview(linked, archive) : undefined)
        budget.routes += expected.length
        if (budget.routes > 20000) throw new Error("Restored Git shared route inventory exceeds bound")
        for (const route of expected) {
          const file = files.get(key(route.source))
          if (!file || file.digest !== route.digest || file.bytes !== route.bytes || selected.has(key(file.path)))
            continue
          const relative = path.relative(data, file.path)
          const bytes = await hashFile(path.join(lookup(token, data), relative), 96 * 1024 * 1024 - budget.bytes)
          budget.bytes += bytes.bytes
          if (bytes.bytes !== file.bytes || bytes.digest !== file.digest)
            throw new Error("Restored Git staged native bytes changed")
          const entry = restoredGit.parse({
            kind: "restored-git",
            archive: archive.id,
            archiveDigest: historicalDigest(archive),
            namespace: group.id,
            componentDigest: historicalDigest(value),
            selector: route.selector,
            data,
            source: file.path,
            dev: file.dev,
            ino: file.ino,
            bytes: file.bytes,
            digest: file.digest,
            ...(file.modified === undefined ? {} : { modified: file.modified }),
            relationship: route.relationship,
            activation: "inert",
          })
          projections.set(archive.id + ":" + group.id, {
            archive: archive.id,
            archiveDigest: historicalDigest(archive),
            namespace: group.id,
            artifacts: value,
            ...(linked ? { context: linked } : {}),
          })
          validateRestoredGit(entry, { restoredArtifacts: restoredArtifacts.parse([...projections.values()]) })
          selected.set(key(file.path), Object.freeze({ ...entry, selector: Object.freeze(entry.selector) }))
        }
      }
    }
  }
  const proof = Object.freeze({ [brand]: true as const })
  claims.set(proof, {
    token,
    groups: Object.freeze([...selected.values()].sort((a, b) => key(a.source).localeCompare(key(b.source)))),
    values: freeze(restoredArtifacts.parse([...projections.values()])),
  })
  return proof
}
export function restoredGitGroups(token: Working, proof: RestoredGitClaim) {
  inventory(token)
  const state = claims.get(proof)
  if (!state || state.token !== token) throw new Error("Restored Git binding belongs to another held image")
  return state.groups
}

export function restoredGitValues(token: Working, proof: RestoredGitClaim) {
  inventory(token)
  const state = claims.get(proof)
  if (!state || state.token !== token) throw new Error("Restored Git projection belongs to another held image")
  return state.values
}
