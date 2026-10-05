import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { discoverGit, discoverStore } from "@opencode-ai/core/kilocode/git-roots"
import { assertWorking, lookup, type Working } from "./profile-image"
import { identity } from "./profile-workspaces"
import { gitConfigProjection } from "./profile-git-metadata-schema"
import { controls } from "./profile-artifact-controls"
import { scaffold, inspect as inspectScaffold, bind as bindScaffold } from "./profile-snapshot-scaffolds"

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
function sanitize(text: string) {
  const entries = new Map<string, string>()
  const allowed: Readonly<Record<string, readonly string[]>> = {
    core: [
      "repositoryformatversion",
      "bare",
      "filemode",
      "ignorecase",
      "logallrefupdates",
      "precomposeunicode",
      "symlinks",
    ],
    extensions: ["objectformat", "worktreeconfig"],
  }
  let section = ""
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith("[")) {
      section = line.match(/^\s*\[([a-z]+)\]\s*$/i)?.[1]?.toLowerCase() ?? ""
      continue
    }
    const entry = line.match(/^\s*([a-z]+)\s*=\s*(true|false|\d+|sha1|sha256)\s*(?:[;#].*)?$/i)
    if (entry && allowed[section]?.includes(entry[1].toLowerCase()))
      entries.set(`${section}.${entry[1].toLowerCase()}`, entry[2].toLowerCase())
  }
  return (
    ["core", "extensions"]
      .flatMap((section) => {
        const rows = [...entries]
          .filter(([key]) => key.startsWith(section + "."))
          .sort(([a], [b]) => a.localeCompare(b))
        return rows.length
          ? [`[${section}]`, ...rows.map(([key, value]) => `\t${key.slice(section.length + 1)} = ${value}`)]
          : []
      })
      .join("\n") + "\n"
  )
}
/** Safe configuration projection with a finite ledger; excluded source text is never emitted. */
export function projectGitConfig(text: string) {
  if (Buffer.byteLength(text) > 262144) throw new Error("Git metadata configuration exceeds bound")
  const lines = text.split(/\r?\n/)
  if (lines.length > 20000) throw new Error("Git metadata configuration line inventory exceeds bound")
  const projected = sanitize(text)
  const allowed = new Set<string>()
  let part = ""
  for (const line of projected.split("\n")) {
    if (line.startsWith("[")) part = line.slice(1, -1)
    else if (line.trim()) allowed.add(`${part}.${line.trim()}`)
  }
  const omitted: Readonly<Record<string, readonly string[]>> = {
    core: ["worktree", "hookspath", "fsmonitor"],
    user: ["name", "email"],
    remote: ["url", "pushurl", "fetch"],
    branch: ["remote", "merge"],
    credential: ["helper", "username", "usehttppath"],
    include: ["path"],
    includeif: ["path"],
  }
  let section = ""
  const ledger = lines.flatMap<z.output<typeof gitConfigProjection>["ledger"][number]>((line, index) => {
    const value = line.trim()
    if (!value || /^[;#]/.test(value)) return [{ line: index, reason: "formatting" as const }]
    if (value.startsWith("[")) {
      section = value.match(/^\[([a-z]+)(?:\s+"[^"\r\n]*")?\]$/i)?.[1]?.toLowerCase() ?? ""
      if (
        !["core", "extensions", ...Object.keys(omitted)].includes(section) ||
        (value.includes('"') && !["remote", "branch", "credential", "includeif"].includes(section))
      ) {
        section = ""
        return [{ line: index, reason: "unsupported" as const }]
      }
      return [{ line: index, reason: "section-formatting" as const }]
    }
    const entry = line.match(/^\s*([a-z]+)\s*=\s*(true|false|\d+|sha1|sha256)\s*(?:[;#].*)?$/i)
    const kept =
      entry &&
      ["core", "extensions"].includes(section) &&
      allowed.has(`${section}.${entry[1].toLowerCase()} = ${entry[2].toLowerCase()}`)
    if (kept) return [{ line: index, reason: "canonical-safe-value" as const }]
    if (
      section === "core" &&
      entry &&
      ((entry[1].toLowerCase() === "autocrlf" && entry[2].toLowerCase() === "false") ||
        (entry[1].toLowerCase() === "longpaths" && entry[2].toLowerCase() === "true"))
    )
      return [{ line: index, reason: "omitted-source-platform-option" as const }]
    const field = line.match(/^\s*([a-z]+)\s*=/i)?.[1]?.toLowerCase()
    if (field && omitted[section]?.includes(field))
      return [
        {
          line: index,
          reason:
            section === "user" ? ("omitted-personal-identity" as const) : ("omitted-connection-or-execution" as const),
        },
      ]
    return [{ line: index, reason: "unsupported" as const }]
  })
  return { text: projected, ledger, supported: ledger.every((line) => line.reason !== "unsupported") }
}
const relative = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.includes(":") &&
      !/[\x00-\x1f\x7f]/.test(value) &&
      value
        .split("/")
        .every(
          (part) =>
            part &&
            part !== "." &&
            part !== ".." &&
            !/[. ]$/.test(part) &&
            !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        ),
    "Unsafe artifact path",
  )
const file = z
  .object({
    path: relative,
    bytes: z.string().max(44_739_244),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    mode: z.number().int().min(0).max(0o777),
    projection: gitConfigProjection.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.projection && !["config", "config.worktree"].includes(value.path))
      ctx.addIssue({ code: "custom", message: "Git config projection has an unsupported file selector" })
  })
const checkout = z
  .object({
    files: z.array(file).max(20_000),
    directories: z.array(relative).max(20_000),
    excluded: z
      .array(z.object({ path: relative, reason: z.enum(["configuration", "credentials"]) }).strict())
      .max(20_000),
  })
  .strict()
function exclusion(name: string) {
  const value = path.posix.basename(name).toLowerCase()
  if (/^(?:kilo|opencode|raya)\.jsonc?$/.test(value)) return "configuration" as const
  if (/^\.env(?:\.|$)/.test(value) || /^(?:auth|credentials)\.json$/.test(value)) return "credentials" as const
  return undefined
}
const repository = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    source: z.string().min(1).max(4096),
    files: z.array(file).max(20_000),
    directories: z.array(relative).max(20_000),
    alternates: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(64),
    objectFormat: z.enum(["sha1", "sha256"]),
    workspace: z.string().min(1).max(4096).optional(),
    working: checkout.optional(),
  })
  .strict()
export const artifacts = z
  .object({
    version: z.literal(1),
    snapshotScaffolds: z.array(scaffold).max(256).optional(),
    repositories: z.array(repository).max(256),
    snapshots: z
      .array(
        z
          .object({
            project: relative,
            workspace: z.string().min(1).max(4096),
            repository: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(10_000),
    worktrees: z
      .array(
        z
          .object({
            project: relative,
            name: relative,
            workspace: z.string().min(1).max(4096),
            common: z.string().regex(/^[a-f0-9]{64}$/),
            admin: z.array(file).max(20_000),
            adminDirectories: z.array(relative).max(20_000),
            files: z.array(file).max(20_000),
            directories: z.array(relative).max(20_000),
          })
          .strict(),
      )
      .max(10_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (controls(value)) ctx.addIssue({ code: "custom", message: "Unsupported active profile coordination artifact" })
    if (
      new Set(value.snapshotScaffolds?.map((item) => identity(item.source))).size !==
      (value.snapshotScaffolds?.length ?? 0)
    )
      ctx.addIssue({ code: "custom", message: "Duplicate Snapshot coordination scaffold" })
    const ids = new Set(value.repositories.map((item) => item.id))
    if (ids.size !== value.repositories.length) ctx.addIssue({ code: "custom", message: "Duplicate Git repository" })
    const names = new Set<string>()
    let total = value.snapshotScaffolds ? Buffer.byteLength(JSON.stringify(value.snapshotScaffolds)) : 0
    const inventories = [
      ...value.repositories.map((item) => ({ files: item.files, directories: item.directories })),
      ...value.repositories.flatMap((item) => (item.working ? [item.working] : [])),
      ...value.worktrees.flatMap((item) => [
        { files: item.files, directories: item.directories },
        { files: item.admin, directories: item.adminDirectories },
      ]),
    ]
    if (
      inventories.reduce((count, item) => count + item.files.length + item.directories.length, 0) +
        inventories.reduce(
          (count, item) => count + item.files.reduce((sum, file) => sum + (file.projection?.ledger.length ?? 0), 0),
          0,
        ) +
        value.repositories.reduce((count, item) => count + (item.working?.excluded.length ?? 0), 0) +
        (value.snapshotScaffolds?.reduce((count, item) => count + 1 + item.children.length, 0) ?? 0) >
      20_000
    ) {
      ctx.addIssue({ code: "custom", message: "Git artifacts exceed the portable node bound" })
      return
    }
    for (const item of inventories) {
      const files = new Set(item.files.map((file) => file.path.toLowerCase()))
      const entries = [...files, ...item.directories.map((dir) => dir.toLowerCase())]
      if (
        new Set(entries).size !== item.files.length + item.directories.length ||
        entries.some((entry) =>
          entry
            .split("/")
            .slice(0, -1)
            .some((_, index, parts) => files.has(parts.slice(0, index + 1).join("/"))),
        )
      )
        ctx.addIssue({ code: "custom", message: "Artifact namespace collision" })
    }
    for (const item of value.repositories) {
      if (item.working) {
        if (item.working.files.some((file) => file.projection))
          ctx.addIssue({ code: "custom", message: "Working checkout cannot grant Git config provenance" })
        if (!item.workspace) ctx.addIssue({ code: "custom", message: "Unbound primary working bytes" })
        const entries = [...item.working.files.map((file) => file.path), ...item.working.directories]
        const omitted = item.working.excluded.map((file) => file.path.toLowerCase())
        if (
          new Set([...entries.map((file) => file.toLowerCase()), ...omitted]).size !==
          entries.length + omitted.length
        )
          ctx.addIssue({ code: "custom", message: "Primary working exclusion collision" })
        if (entries.some((file) => file.split("/").some((part) => part.toLowerCase() === ".git") || exclusion(file)))
          ctx.addIssue({ code: "custom", message: "Primary working control bytes require typed evidence" })
        if (item.working.excluded.some((file) => exclusion(file.path) !== file.reason))
          ctx.addIssue({ code: "custom", message: "Unsupported primary working exclusion" })
      }
      if (digest(identity(item.source)) !== item.id || item.alternates.some((id) => !ids.has(id)))
        ctx.addIssue({ code: "custom", message: "Unbound Git repository" })
      if (item.workspace && identity(`${item.workspace}/.git`) !== identity(item.source))
        ctx.addIssue({ code: "custom", message: "Unbound primary Git workspace" })
      if (
        [...item.files.map((file) => file.path), ...item.directories].some((file) =>
          /^(?:modules|worktrees)(?:\/|$)/i.test(file),
        )
      )
        ctx.addIssue({ code: "custom", message: "Nested Git metadata must use typed worktree records" })
      if (
        item.files.some((file) => /^disabled-hooks(?:\/|$)/i.test(file.path)) ||
        item.directories.some((dir) => /^disabled-hooks\//i.test(dir))
      )
        ctx.addIssue({ code: "custom", message: "Generated disabled hooks namespace must remain empty" })
      if (
        item.alternates.some(
          (id) => value.repositories.find((repository) => repository.id === id)?.objectFormat !== item.objectFormat,
        )
      )
        ctx.addIssue({ code: "custom", message: "Git alternate object format mismatch" })
    }
    for (const files of [
      ...value.repositories.map((item) => item.files),
      ...value.worktrees.map((item) => item.admin),
    ]) {
      for (const file of files.filter(
        (file) => file.path.toLowerCase() === "config" || file.path.toLowerCase() === "config.worktree",
      )) {
        const text = Buffer.from(file.bytes, "base64").toString("utf8")
        if (sanitize(text) !== text)
          ctx.addIssue({ code: "custom", message: "Git config evidence is outside the safe inert allowlist" })
      }
    }
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const cycle = (id: string): boolean => {
      if (visiting.has(id)) return true
      if (visited.has(id)) return false
      visiting.add(id)
      if (value.repositories.find((item) => item.id === id)?.alternates.some(cycle)) return true
      visiting.delete(id)
      visited.add(id)
      return false
    }
    if (value.repositories.some((item) => cycle(item.id)))
      ctx.addIssue({ code: "custom", message: "Cyclic Git object alternates" })
    for (const item of value.snapshots) {
      if (!ids.has(item.repository)) ctx.addIssue({ code: "custom", message: "Missing snapshot repository" })
      identity(item.workspace)
      const key = `snapshot:${item.project}:${identity(item.workspace)}`
      if (names.has(key)) ctx.addIssue({ code: "custom", message: "Duplicate snapshot" })
      names.add(key)
    }
    for (const item of value.worktrees) {
      if (!ids.has(item.common) || item.project.includes("/") || item.name.includes("/"))
        ctx.addIssue({ code: "custom", message: "Invalid managed worktree" })
      const key = `worktree:${identity(item.workspace)}`
      if (names.has(key)) ctx.addIssue({ code: "custom", message: "Duplicate managed worktree" })
      names.add(key)
    }
    for (const files of [
      ...value.repositories.map((item) => item.files),
      ...value.repositories.flatMap((item) => (item.working ? [item.working.files] : [])),
      ...value.worktrees.flatMap((item) => [item.admin, item.files]),
    ]) {
      if (new Set(files.map((item) => item.path.toLowerCase())).size !== files.length)
        ctx.addIssue({ code: "custom", message: "Artifact path collision" })
      for (const item of files) {
        const bytes = Buffer.from(item.bytes, "base64")
        total += bytes.length + (item.projection ? Buffer.byteLength(JSON.stringify(item.projection)) : 0)
        if (bytes.toString("base64") !== item.bytes || bytes.length > 32 * 1024 * 1024 || digest(bytes) !== item.digest)
          ctx.addIssue({ code: "custom", message: "Artifact byte identity mismatch" })
      }
    }
    if (total > 96 * 1024 * 1024)
      ctx.addIssue({ code: "custom", message: "Git artifacts exceed the portable byte bound" })
  })
export type Artifacts = z.infer<typeof artifacts>
export type Selection = Readonly<{ data: string; workspaces: readonly string[] }>

/** Read-only planning, not capture authority. Feed these physical roots to policy/image selection. */
export async function discover(selected: Selection) {
  const roots = new Map<string, string>()
  const exists = async (file: string) =>
    lstat(file).catch((err: unknown) => {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined
      throw err
    })
  const include = (files: readonly string[]) => {
    for (const file of files) roots.set(identity(file), file)
    if (roots.size > 256) throw new Error("Git repository inventory exceeds bound")
  }
  for (const workspace of selected.workspaces) {
    include((await discoverGit(workspace)).roots)
    if ((await exists(path.join(workspace, ".git")))?.isDirectory()) include([workspace])
  }
  const snapshots = path.join(selected.data, "snapshot")
  if (await exists(snapshots)) {
    for (const project of await readdir(snapshots)) {
      if (project.toLowerCase() === ".raya-profile-locks") {
        await inspectScaffold(path.join(snapshots, project))
        continue
      }
      for (const name of await readdir(path.join(snapshots, project))) {
        if (name.toLowerCase() === ".raya-profile-locks") {
          await inspectScaffold(path.join(snapshots, project, name))
          continue
        }
        include((await discoverStore(path.join(snapshots, project, name))).roots)
      }
    }
  }
  const worktrees = path.join(selected.data, "worktree")
  if (await exists(worktrees)) {
    for (const project of await readdir(worktrees)) {
      for (const name of await readdir(path.join(worktrees, project))) {
        const workspace = path.join(worktrees, project, name)
        const value = await discoverGit(workspace)
        if (!value.metadata) throw new Error("Managed worktree has no typed Git backlink")
        include(value.roots)
      }
    }
  }
  return Object.freeze([...roots.values()].sort().map((file) => Object.freeze({ kind: "json" as const, path: file })))
}

function inside(root: string, file: string) {
  const value = path.relative(root, file)
  return value === "" || (!value.startsWith(`..${path.sep}`) && value !== ".." && !path.isAbsolute(value))
}

const slash = (file: string) => file.split(path.sep).join("/")
const inert = (name: string) => {
  const value = name.toLowerCase()
  return (
    value === "config" ||
    value === "config.worktree" ||
    value === "objects/info/alternates" ||
    value.startsWith("hooks/") ||
    value === "info/attributes" ||
    value === "gitdir" ||
    value === "commondir"
  )
}
export const renderGitConfig = (root: string, format: "sha1" | "sha256", workspace?: string) =>
  Buffer.from(
    `[core]\n\trepositoryformatversion = ${format === "sha256" ? 1 : 0}\n\tbare = false\n\tfilemode = false\n\thooksPath = ${JSON.stringify(slash(path.join(root, "disabled-hooks")))}\n${workspace ? `\tworktree = ${JSON.stringify(slash(workspace))}\n` : ""}${format === "sha256" ? "[extensions]\n\tobjectFormat = sha256\n" : ""}`,
  )
export const renderGitLink = (workspace: string) => Buffer.from(slash(path.join(workspace, ".git")) + "\n")
export const renderGitCommon = () => Buffer.from("../..\n")
async function write(root: string, file: string, bytes: Buffer, mode = 0o600) {
  const target = path.join(root, ...file.split("/"))
  await mkdir(path.dirname(target), { recursive: true })
  const handle = await open(target, "wx", 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  if (process.platform !== "win32") await chmod(target, mode)
}
export function locations(
  value: Artifacts,
  destination: string,
  mappings: ReadonlyMap<string, string>,
  primaries: readonly string[],
) {
  return new Map(
    value.repositories.map((item) => {
      const primary = item.workspace && primaries.some((source) => identity(source) === identity(item.workspace!))
      const mapped = primary
        ? [...mappings].find(([file]) => identity(file) === identity(item.workspace!))?.[1]
        : undefined
      if (primary && !mapped) throw new Error("Primary Git attachment requires explicit mapping")
      return [
        item.id,
        mapped ? path.join(mapped, ".git") : path.join(destination, "git-artifacts", "repositories", item.id),
      ]
    }),
  )
}

/** Every read resolves through the still-live locked image, never through an original Git path. */
export async function collect(
  working: Working,
  selected: Selection,
  budget: Readonly<{ bytes: number; nodes: number }> = { bytes: 96 * 1024 * 1024, nodes: 20_000 },
): Promise<Artifacts> {
  if (
    !Number.isSafeInteger(budget.bytes) ||
    !Number.isSafeInteger(budget.nodes) ||
    budget.bytes < 0 ||
    budget.nodes < 0
  )
    throw new Error("Invalid Git artifact budget")
  const value = assertWorking(working)
  const mapped = (file: string) => {
    assertWorking(working)
    const root = value.original
      .map((root, index) => ({ root, index }))
      .filter(({ root }) => root.kind === "json" && inside(root.path, file))
      .sort((a, b) => b.root.path.length - a.root.path.length)[0]
    if (!root) throw new Error("Git artifact lies outside the locked profile image")
    return path.join(lookup(working, root.root.path), path.relative(root.root.path, file))
  }
  const exists = async (file: string) =>
    lstat(mapped(file)).catch((err: unknown) => {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined
      throw err
    })
  const text = async (file: string) => (await readFile(mapped(file))).toString("utf8")
  let total = 0
  let count = 0
  const files = async (root: string, skip: (file: string) => boolean = () => false, metadata = false) => {
    const result: z.infer<typeof file>[] = []
    const directories: string[] = []
    const visit = async (dir: string, depth: number): Promise<void> => {
      if (depth > 64) throw new Error("Git artifact nesting exceeds bound")
      for (const entry of (await readdir(mapped(dir), { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const source = path.join(dir, entry.name)
        const name = path.relative(root, source).split(path.sep).join("/")
        if (skip(name)) continue
        const info = await lstat(mapped(source))
        if (info.isSymbolicLink()) throw new Error("Git artifact symbolic links require explicit inert mapping")
        if (info.isDirectory()) {
          count++
          if (count > Math.min(20_000, budget.nodes)) throw new Error("Git artifact inventory exceeds bound")
          directories.push(name)
          await visit(source, depth + 1)
          continue
        }
        if (!info.isFile() || info.nlink !== 1 || info.size > 32 * 1024 * 1024)
          throw new Error("Unbounded or aliased Git artifact")
        count++
        total += info.size
        if (count > Math.min(20_000, budget.nodes) || total > Math.min(96 * 1024 * 1024, budget.bytes))
          throw new Error("Git artifact inventory exceeds bound")
        const original = await readFile(mapped(source))
        const projection =
          metadata &&
          ["config", "config.worktree"].includes(name) &&
          original.length <= 262144 &&
          original.toString("utf8").split(/\r?\n/).length <= 20000
            ? projectGitConfig(new TextDecoder("utf-8", { fatal: true }).decode(original))
            : undefined
        const bytes =
          metadata && (name.toLowerCase() === "config" || name.toLowerCase() === "config.worktree")
            ? Buffer.from(sanitize(original.toString("utf8")))
            : original
        if (projection) {
          count += projection.ledger.length
          total += Buffer.byteLength(JSON.stringify(projection))
          if (count > Math.min(20_000, budget.nodes) || total > Math.min(96 * 1024 * 1024, budget.bytes))
            throw new Error("Git configuration provenance exceeds artifact inventory bound")
        }
        result.push({
          path: name,
          bytes: bytes.toString("base64"),
          digest: digest(bytes),
          mode: info.mode & 0o777,
          ...(projection
            ? {
                projection: {
                  kind: "safe-git-config" as const,
                  sourceDigest: digest(original),
                  sourceBytes: original.length,
                  supported: projection.supported,
                  ledger: projection.ledger,
                },
              }
            : {}),
        })
      }
    }
    await visit(root, 0)
    return { files: result, directories }
  }
  const repositories = new Map<string, Artifacts["repositories"][number]>()
  const repository = async (source: string): Promise<string> => {
    const id = digest(identity(source))
    if (repositories.has(id)) return id
    repositories.set(id, { id, source, files: [], directories: [], alternates: [], objectFormat: "sha1" })
    const item = repositories.get(id)!
    item.workspace = selected.workspaces.find(
      (workspace) => identity(path.join(workspace, ".git")) === identity(source),
    )
    const configuration = (await exists(path.join(source, "config"))) ? await text(path.join(source, "config")) : ""
    for (const entry of configuration.matchAll(
      /^\s*(refstorage|sparsecheckout|sparsecheckoutcone|sparse)\s*=\s*(.+)$/gim,
    )) {
      const setting = entry[2]
        .trim()
        .replace(/\s+[;#].*$/, "")
        .replace(/^"|"$/g, "")
        .toLowerCase()
      if (setting !== "false" && setting !== "0" && !(entry[1].toLowerCase() === "refstorage" && setting === "files"))
        throw new Error("Git reftable/sparse metadata requires an explicit portable mapping")
    }
    const entry = sanitize(configuration).match(/^\s*objectformat\s*=\s*(.+)$/im)?.[1]
    const format = entry
      ?.trim()
      .replace(/\s+[;#].*$/, "")
      .replace(/^"|"$/g, "")
      .toLowerCase()
    if (format && format !== "sha1" && format !== "sha256") throw new Error("Unsupported Git object format")
    item.objectFormat = format === "sha256" ? "sha256" : "sha1"
    Object.assign(
      item,
      await files(
        source,
        (name) => name.toLowerCase() === "worktrees" || name.toLowerCase().startsWith("worktrees/"),
        true,
      ),
    )
    if (
      item.files.some((file) => file.path.toLowerCase().startsWith("modules/")) ||
      item.directories.some((dir) => dir.toLowerCase() === "modules")
    )
      throw new Error("Git submodule metadata requires an explicit portable mapping")
    if (item.files.some((file) => file.path.endsWith(".lock")))
      throw new Error("Unfinished Git metadata publication requires review")
    const alternate = path.join(source, "objects", "info", "alternates")
    if (await exists(alternate)) {
      for (const line of (await text(alternate)).split(/\r?\n/).filter(Boolean)) {
        if (line.startsWith('"') || line.includes("\0")) throw new Error("Unsupported Git alternate encoding")
        const objects = path.resolve(source, "objects", line)
        if (path.basename(objects) !== "objects") throw new Error("Unsupported Git alternate object directory")
        item.alternates.push(await repository(path.dirname(objects)))
      }
    }
    return id
  }
  const snapshots: Artifacts["snapshots"] = []
  const scaffolds: z.output<typeof scaffold>[] = []
  const worktrees: Artifacts["worktrees"] = []
  const snapshotsRoot = path.join(selected.data, "snapshot")
  if (await exists(snapshotsRoot)) {
    for (const project of await readdir(mapped(snapshotsRoot))) {
      if (project.toLowerCase() === ".raya-profile-locks") {
        const source = path.join(snapshotsRoot, project)
        scaffolds.push(await bindScaffold(working, source, mapped(source)))
        continue
      }
      for (const name of await readdir(mapped(path.join(snapshotsRoot, project)))) {
        if (name.toLowerCase() === ".raya-profile-locks") {
          const source = path.join(snapshotsRoot, project, name)
          scaffolds.push(await bindScaffold(working, source, mapped(source)))
          continue
        }
        const workspace = selected.workspaces.find((workspace) =>
          [workspace, path.normalize(workspace)].some((file) => createHash("sha1").update(file).digest("hex") === name),
        )
        if (!workspace) throw new Error("Snapshot directory has no explicit workspace identity")
        snapshots.push({ project, workspace, repository: await repository(path.join(snapshotsRoot, project, name)) })
      }
    }
  }
  const worktreesRoot = path.join(selected.data, "worktree")
  const tree = async (workspace: string, project: string, name: string) => {
    const pointer = await text(path.join(workspace, ".git"))
    if (!pointer.startsWith("gitdir: ")) throw new Error("Historical worktree has no typed Git backlink")
    const admin = path.resolve(workspace, pointer.slice(8).trim())
    const common = path.resolve(admin, (await text(path.join(admin, "commondir"))).trim())
    const metadata = await files(admin, () => false, true)
    if (metadata.files.some((file) => file.path.endsWith(".lock")))
      throw new Error("Unfinished Git worktree publication requires review")
    const content = await files(workspace, (name) => name === ".git")
    if (
      content.files.some((item) => item.path.split("/").includes(".git")) ||
      content.directories.some((item) => item.split("/").includes(".git"))
    )
      throw new Error("Nested Git worktree metadata requires an explicit portable mapping")
    worktrees.push({
      project,
      name,
      workspace,
      common: await repository(common),
      admin: metadata.files,
      adminDirectories: metadata.directories,
      ...content,
    })
  }
  if (await exists(worktreesRoot)) {
    for (const project of await readdir(mapped(worktreesRoot))) {
      for (const name of await readdir(mapped(path.join(worktreesRoot, project)))) {
        const workspace = path.join(worktreesRoot, project, name)
        await tree(workspace, project, name)
      }
    }
  }
  for (const workspace of selected.workspaces) {
    if (worktrees.some((item) => identity(item.workspace) === identity(workspace))) continue
    const git = path.join(workspace, ".git")
    const info = await exists(git)
    if (!info) continue
    if (info.isDirectory()) {
      const id = await repository(git)
      const excluded: z.infer<typeof checkout>["excluded"] = []
      const content = await files(workspace, (name) => {
        if (name.toLowerCase() === ".git") return true
        const reason = exclusion(name)
        if (!reason) return false
        excluded.push({ path: name, reason })
        count++
        if (count > Math.min(20_000, budget.nodes)) throw new Error("Git artifact inventory exceeds bound")
        return true
      })
      if (
        [...content.files.map((file) => file.path), ...content.directories].some((file) =>
          file.split("/").some((part) => part.toLowerCase() === ".git"),
        )
      )
        throw new Error("Nested primary Git metadata requires an explicit portable mapping")
      repositories.get(id)!.working = { ...content, excluded }
      continue
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Historical Git namespace is unsupported")
    await tree(workspace, "historical", digest(identity(workspace)))
  }
  assertWorking(working)
  return artifacts.parse({
    version: 1,
    repositories: [...repositories.values()],
    snapshots,
    worktrees,
    ...(scaffolds.length ? { snapshotScaffolds: scaffolds } : {}),
  })
}

async function scaffoldEvidence(value: Artifacts, stage: string) {
  for (const item of value.snapshotScaffolds ?? []) {
    const root = path.join(stage, "git-artifacts", "snapshot-scaffold-evidence", digest(identity(item.source)))
    await mkdir(root, { recursive: true })
    for (const child of item.children) await mkdir(path.join(root, child.name), { recursive: true })
  }
}

/** Rebuild inside an unpublished container. Original config/hooks are evidence, never activated. */
export async function materialize(
  input: Artifacts,
  stage: string,
  destination: string,
  mappings: ReadonlyMap<string, string>,
  primaries: readonly string[] = [],
) {
  if (controls(input)) throw new Error("Unsupported active profile coordination artifact")
  const value = artifacts.parse(input)
  const mapped = (source: string) => [...mappings].find(([file]) => identity(file) === identity(source))?.[1]
  const roots = locations(value, destination, mappings, primaries)
  await scaffoldEvidence(value, stage)
  for (const item of value.repositories) {
    if (item.working) {
      const evidence = path.join(stage, "git-artifacts", "primary-evidence", item.id)
      for (const dir of item.working.directories)
        await mkdir(path.join(evidence, "tree", ...dir.split("/")), { recursive: true })
      for (const file of item.working.files)
        await write(path.join(evidence, "tree"), file.path, Buffer.from(file.bytes, "base64"), file.mode)
      await write(
        evidence,
        "manifest.json",
        Buffer.from(
          JSON.stringify({ version: 1, source: item.workspace, excluded: item.working.excluded, active: false }),
        ),
      )
    }
    const root = path.join(stage, "git-artifacts", "repositories", item.id)
    for (const dir of item.directories)
      await mkdir(
        path.join(inert(dir + "/") ? path.join(stage, "git-artifacts", "evidence", item.id) : root, ...dir.split("/")),
        { recursive: true },
      )
    for (const file of item.files)
      await write(
        inert(file.path) ? path.join(stage, "git-artifacts", "evidence", item.id) : root,
        file.path,
        Buffer.from(file.bytes, "base64"),
      )
    const primary =
      item.workspace && primaries.some((source) => identity(source) === identity(item.workspace!))
        ? mapped(item.workspace)
        : undefined
    if (item.workspace && primaries.some((source) => identity(source) === identity(item.workspace!)) && !primary)
      throw new Error("Primary Git attachment requires explicit mapping")
    await write(root, "config", renderGitConfig(roots.get(item.id)!, item.objectFormat, primary))
    await mkdir(path.join(root, "disabled-hooks"), { recursive: true })
    if (item.alternates.length)
      await write(
        root,
        "objects/info/alternates",
        Buffer.from(item.alternates.map((id) => slash(path.join(roots.get(id)!, "objects"))).join("\n") + "\n"),
      )
  }
  for (const item of value.snapshots) {
    const workspace = mapped(item.workspace)
    if (!workspace) throw new Error("Snapshot workspace requires an explicit destination mapping")
    const root = path.join(stage, "snapshot", item.project, createHash("sha1").update(workspace).digest("hex"))
    const repository = value.repositories.find((repository) => repository.id === item.repository)!
    for (const dir of repository.directories)
      await mkdir(
        path.join(
          inert(dir + "/") ? path.join(stage, "git-artifacts", "snapshot-evidence", item.repository) : root,
          ...dir.split("/"),
        ),
        { recursive: true },
      )
    for (const file of repository.files)
      await write(
        inert(file.path) ? path.join(stage, "git-artifacts", "snapshot-evidence", item.repository) : root,
        file.path,
        Buffer.from(file.bytes, "base64"),
      )
    await write(
      root,
      "config",
      renderGitConfig(path.join(destination, "snapshot", item.project, path.basename(root)), repository.objectFormat),
    )
    await mkdir(path.join(root, "disabled-hooks"), { recursive: true })
    if (repository.alternates.length)
      await write(
        root,
        "objects/info/alternates",
        Buffer.from(repository.alternates.map((id) => slash(path.join(roots.get(id)!, "objects"))).join("\n") + "\n"),
      )
  }
  for (const item of value.worktrees) {
    const workspace = path.join(destination, "worktree", item.project, item.name)
    if (mapped(item.workspace) !== workspace)
      throw new Error("Managed worktree mapping must target the reserved inactive profile")
    const root = path.join(stage, "worktree", item.project, item.name)
    for (const dir of item.directories) await mkdir(path.join(root, ...dir.split("/")), { recursive: true })
    for (const file of item.files) await write(root, file.path, Buffer.from(file.bytes, "base64"), file.mode)
    const name = digest(identity(item.workspace))
    const admin = path.join(stage, "git-artifacts", "repositories", item.common, "worktrees", name)
    for (const dir of item.adminDirectories) await mkdir(path.join(admin, ...dir.split("/")), { recursive: true })
    for (const file of item.admin)
      await write(
        inert(file.path) ? path.join(stage, "git-artifacts", "worktree-evidence", name) : admin,
        file.path,
        Buffer.from(file.bytes, "base64"),
      )
    await write(admin, "commondir", renderGitCommon())
    await write(admin, "gitdir", renderGitLink(workspace))
    await write(root, ".git", Buffer.from(`gitdir: ${slash(path.join(roots.get(item.common)!, "worktrees", name))}\n`))
  }
}

/** Explicit fresh-primary registration, after inactive profile publication. Never attach to existing Git metadata. */
export async function attach(
  input: Artifacts,
  destination: string,
  mappings: ReadonlyMap<string, string>,
  primaries: readonly string[],
) {
  if (controls(input)) throw new Error("Unsupported active profile coordination artifact")
  const value = artifacts.parse(input)
  const roots = locations(value, destination, mappings, primaries)
  if (new Set(primaries.map(identity)).size !== primaries.length) throw new Error("Duplicate primary Git attachment")
  const selected = await Promise.all(
    primaries.map(async (source) => {
      const item = value.repositories.find((item) => item.workspace && identity(item.workspace) === identity(source))
      const mapped = [...mappings].find(([file]) => identity(file) === identity(source))?.[1]
      if (!item || !mapped || !path.isAbsolute(mapped))
        throw new Error("Primary Git attachment is not bound to restored metadata")
      const root = await realpath(mapped)
      if (root !== mapped || !(await lstat(root)).isDirectory() || (await readdir(root)).length)
        throw new Error("Primary Git attachment requires a fresh empty physical directory")
      const repository = path.join(destination, "git-artifacts", "repositories", item.id)
      if (!(await lstat(repository)).isDirectory()) throw new Error("Restored primary Git metadata is unavailable")
      return { root, item }
    }),
  )
  const written: { file: string; dev: number; ino: number }[] = []
  try {
    for (const item of selected) {
      if ((await readdir(item.root)).length) throw new Error("Primary Git attachment destination changed")
      const file = path.join(item.root, ".git")
      await mkdir(file)
      const info = await lstat(file)
      written.push({ file, dev: info.dev, ino: info.ino })
      for (const dir of item.item.directories)
        if (!inert(dir + "/")) await mkdir(path.join(file, ...dir.split("/")), { recursive: true })
      for (const entry of item.item.files)
        if (!inert(entry.path)) await write(file, entry.path, Buffer.from(entry.bytes, "base64"))
      await write(file, "config", renderGitConfig(file, item.item.objectFormat, item.root))
      await mkdir(path.join(file, "disabled-hooks"), { recursive: true })
      if (item.item.alternates.length)
        await write(
          file,
          "objects/info/alternates",
          Buffer.from(item.item.alternates.map((id) => slash(path.join(roots.get(id)!, "objects"))).join("\n") + "\n"),
        )
      for (const tree of value.worktrees.filter((tree) => tree.common === item.item.id)) {
        const workspace = path.join(destination, "worktree", tree.project, tree.name)
        const name = digest(identity(tree.workspace))
        const admin = path.join(file, "worktrees", name)
        for (const dir of tree.adminDirectories) await mkdir(path.join(admin, ...dir.split("/")), { recursive: true })
        for (const entry of tree.admin)
          if (!inert(entry.path)) await write(admin, entry.path, Buffer.from(entry.bytes, "base64"))
        await write(admin, "commondir", renderGitCommon())
        await write(admin, "gitdir", renderGitLink(workspace))
      }
    }
  } catch (err) {
    const failures: unknown[] = [err]
    for (const item of written) {
      try {
        const info = await lstat(item.file)
        if (info.dev !== item.dev || info.ino !== item.ino || !info.isDirectory() || info.isSymbolicLink())
          throw new Error("Primary Git attachment rollback identity changed", { cause: err })
        await rename(item.file, `${item.file}.raya-incomplete-${crypto.randomUUID()}`)
      } catch (failure) {
        failures.push(failure)
      }
    }
    const failure = new AggregateError(failures, "Fresh primary Git attachment refused; inactive profile retained", {
      cause: err,
    })
    throw failure
  }
}
