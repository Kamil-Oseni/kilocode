import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { artifacts, projectGitConfig, type Artifacts } from "./profile-artifacts"
import { bindGit, type GitComponents } from "./profile-git-correspondence"
import { assertWorking, inventory, lookup, type Working } from "./profile-image"
import { gitMetadata } from "./profile-git-metadata-schema"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex")
const key = (file: string) => (process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file))
const inside = (root: string, file: string) => {
  const rel = path.relative(root, file)
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`))
}
function component(input: GitComponents, namespace: string) {
  if (namespace === "primary") {
    if (!input.artifacts) throw new Error("Git metadata primary component is missing")
    return artifacts.parse(input.artifacts)
  }
  const values = input.secondary?.namespaces.filter((entry) => entry.id === namespace) ?? []
  if (values.length !== 1 || !values[0].artifacts) throw new Error("Git metadata secondary component is ambiguous")
  return artifacts.parse(values[0].artifacts)
}
function resolve(value: Artifacts, selector: z.output<typeof gitMetadata>["selector"]) {
  if (selector.kind === "config") {
    const matches = value.repositories.filter((repo) => repo.id === selector.id)
    if (matches.length !== 1) throw new Error("Git metadata repository selector is missing")
    const files = matches[0].files.filter((file) => file.path === selector.path)
    if (files.length !== 1) throw new Error("Git metadata config selector is missing")
    return {
      source: path.join(matches[0].source, selector.path),
      digest: files[0].digest,
      bytes: Buffer.from(files[0].bytes, "base64"),
      projection: files[0].projection,
    }
  }
  const trees = value.worktrees.filter(
    (tree) => key(tree.workspace) === key(selector.workspace) && tree.common === selector.common,
  )
  if (trees.length !== 1) throw new Error("Git metadata worktree selector is missing")
  const common = value.repositories.filter((repo) => repo.id === selector.common)
  if (common.length !== 1) throw new Error("Git metadata common repository is missing")
  if (selector.kind === "pointer")
    return {
      source: path.join(trees[0].workspace, ".git"),
      digest: hash({ workspace: trees[0].workspace, common: common[0].source }),
    }
  const files = trees[0].admin.filter((file) => file.path === selector.path)
  if (files.length !== 1) throw new Error("Git metadata admin selector is missing")
  const relative = trees[0].admin.find((file) => file.path === "commondir")
  if (
    !relative ||
    key(path.resolve(selector.admin, Buffer.from(relative.bytes, "base64").toString("utf8").trim())) !==
      key(common[0].source)
  )
    throw new Error("Git metadata admin common binding differs")
  return {
    source: path.join(selector.admin, ...selector.path.split("/")),
    digest: files[0].digest,
    bytes: Buffer.from(files[0].bytes, "base64"),
  }
}
/** Serialized groups validate evidence only. They cannot create a held-image claim. */
export function validateGitMetadata(input: z.input<typeof gitMetadata>, content: GitComponents) {
  const entry = gitMetadata.parse(input)
  const value = component(content, entry.namespace)
  if (hash(value) !== entry.componentDigest) throw new Error("Git metadata component differs")
  const selected = resolve(value, entry.selector)
  if (key(selected.source) !== key(entry.source) || selected.digest !== entry.projectedDigest)
    throw new Error("Git metadata exact selector differs")
  if (selected.bytes && sha(selected.bytes) !== selected.digest)
    throw new Error("Git metadata decoded projection differs")
  if (entry.selector.kind === "config") {
    const projection = "projection" in selected ? selected.projection : undefined
    if (
      !projection?.supported ||
      projection.sourceDigest !== entry.digest ||
      projection.sourceBytes !== entry.bytes ||
      hash(projection.ledger) !== hash(entry.ledger)
    )
      throw new Error("Git metadata config provenance differs")
  }
  if (entry.selector.kind === "admin" && (selected.bytes?.length !== entry.bytes || selected.digest !== entry.digest))
    throw new Error("Git metadata raw admin bytes differ")
}
const freeze = <T>(value: T): T => {
  if (!value || typeof value !== "object") return value
  for (const item of Object.values(value)) freeze(item)
  return Object.freeze(value)
}
const brand: unique symbol = Symbol("held-git-metadata")
export type GitMetadataClaim = Readonly<{ [brand]: true }>
const claims = new WeakMap<object, { token: Working; groups: readonly z.output<typeof gitMetadata>[] }>()
/** Exact finite metadata joins the actual held reader and native inventory; custom configuration stays unclassified. */
export async function bindGitMetadata(token: Working, input: GitComponents): Promise<GitMetadataClaim> {
  await bindGit(token, input)
  const image = assertWorking(token)
  const native = inventory(token)
  const namespaces = [
    ...(input.artifacts ? [{ id: "primary", value: artifacts.parse(input.artifacts) }] : []),
    ...(input.secondary?.namespaces.flatMap((item) =>
      item.artifacts ? [{ id: item.id, value: artifacts.parse(item.artifacts) }] : [],
    ) ?? []),
  ]
  const groups: z.output<typeof gitMetadata>[] = []
  const seen = new Set<string>()
  const read = async (file: string) => {
    const matches = native.files.filter((entry) => key(entry.path) === key(file))
    if (matches.length !== 1) throw new Error("Git metadata lacks exact native file identity")
    const record = matches[0]
    const roots = image.original
      .filter((root) => root.kind === "json" && inside(root.path, file))
      .sort((a, b) => b.path.length - a.path.length)
    if (!roots[0]) throw new Error("Git metadata lies outside declared held roots")
    const bytes = await readFile(path.join(lookup(token, roots[0].path), path.relative(roots[0].path, file)))
    if (bytes.length !== record.bytes || sha(bytes) !== record.digest)
      throw new Error("Git metadata held native bytes differ")
    return { record, bytes }
  }
  const add = (
    namespace: string,
    value: Artifacts,
    selector: z.output<typeof gitMetadata>["selector"],
    record: (typeof native.files)[number],
    projectedDigest: string,
    ledger: z.output<typeof gitMetadata>["ledger"] = [],
  ) => {
    const entry = gitMetadata.parse({
      kind: "git-metadata",
      namespace,
      componentDigest: hash(value),
      selector,
      source: record.path,
      dev: record.dev,
      ino: record.ino,
      bytes: record.bytes,
      digest: record.digest,
      projectedDigest,
      ledger,
      transformation:
        selector.kind === "config"
          ? "safe-config-projection"
          : selector.kind === "pointer" ||
              (selector.kind === "admin" && ["gitdir", "commondir"].includes(selector.path))
            ? "mapped-backlink"
            : "inert-admin-evidence",
      rawBytesPreserved: selector.kind === "admin",
      activation: "inert",
    })
    validateGitMetadata(entry, input)
    const id = `${namespace}:${key(record.path)}`
    if (seen.has(id)) throw new Error("Git metadata physical selector duplicates")
    seen.add(id)
    groups.push(entry)
    if (groups.length > 20000) throw new Error("Git metadata inventory exceeds bound")
  }
  for (const namespace of namespaces) {
    for (const repo of namespace.value.repositories) {
      for (const file of repo.files.filter((file) => ["config", "config.worktree"].includes(file.path))) {
        if (!file.projection?.supported) continue
        const actual = await read(path.join(repo.source, file.path))
        const projected = projectGitConfig(new TextDecoder("utf-8", { fatal: true }).decode(actual.bytes))
        if (!projected.supported) continue
        if (
          file.projection.sourceDigest !== actual.record.digest ||
          file.projection.sourceBytes !== actual.record.bytes ||
          hash(file.projection.ledger) !== hash(projected.ledger)
        )
          throw new Error("Git metadata native config provenance differs")
        if (sha(projected.text) !== file.digest) throw new Error("Git metadata actual config projection differs")
        add(
          namespace.id,
          namespace.value,
          { kind: "config", id: repo.id, path: z.enum(["config", "config.worktree"]).parse(file.path) },
          actual.record,
          file.digest,
          projected.ledger.filter(
            (line): line is typeof line & { reason: Exclude<typeof line.reason, "unsupported"> } =>
              line.reason !== "unsupported",
          ),
        )
      }
    }
    for (const tree of namespace.value.worktrees) {
      const actual = await read(path.join(tree.workspace, ".git"))
      const text = new TextDecoder("utf-8", { fatal: true }).decode(actual.bytes)
      if (!/^gitdir: [^\0\r\n]+(?:\r?\n)?$/.test(text)) throw new Error("Git metadata pointer encoding is unsupported")
      const admin = path.resolve(tree.workspace, text.slice(8).trim())
      const common = namespace.value.repositories.find((repo) => repo.id === tree.common)
      if (!common) throw new Error("Git metadata common repository is missing")
      const relative = await read(path.join(admin, "commondir"))
      if (
        key(path.resolve(admin, new TextDecoder("utf-8", { fatal: true }).decode(relative.bytes).trim())) !==
        key(common.source)
      )
        throw new Error("Git metadata held common binding differs")
      const backlink = await read(path.join(admin, "gitdir"))
      if (
        key(new TextDecoder("utf-8", { fatal: true }).decode(backlink.bytes).trim()) !==
        key(path.join(tree.workspace, ".git"))
      )
        throw new Error("Git metadata held worktree backlink differs")
      add(
        namespace.id,
        namespace.value,
        { kind: "pointer", workspace: tree.workspace, common: tree.common },
        actual.record,
        hash({ workspace: tree.workspace, common: common.source }),
      )
      for (const file of tree.admin.filter((file) =>
        ["HEAD", "index", "logs/HEAD", "ORIG_HEAD", "commondir", "gitdir"].includes(file.path),
      )) {
        const selected = await read(path.join(admin, ...file.path.split("/")))
        add(
          namespace.id,
          namespace.value,
          {
            kind: "admin",
            workspace: tree.workspace,
            common: tree.common,
            admin,
            path: z.enum(["HEAD", "index", "logs/HEAD", "ORIG_HEAD", "commondir", "gitdir"]).parse(file.path),
          },
          selected.record,
          file.digest,
        )
      }
    }
  }
  inventory(token)
  const claim = Object.freeze({ [brand]: true as const })
  claims.set(claim, { token, groups: freeze(groups) })
  return claim
}
export function gitMetadataGroups(token: Working, claim: GitMetadataClaim) {
  inventory(token)
  const state = claims.get(claim)
  if (!state || state.token !== token) throw new Error("Git metadata binding is absent or belongs to another image")
  return state.groups
}
