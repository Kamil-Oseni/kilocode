import { createHash } from "node:crypto"
import { lstat, mkdir, open, readdir } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { z } from "zod"
import { PlanArtifact } from "../plan-artifact"
import { assertWorking, lookup, type Working } from "./profile-image"
import { identity } from "./profile-workspaces"

const sum = (value: string) => createHash("sha256").update(value).digest("hex")
const name = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !/[\\/:\x00-\x1f\x7f]/.test(value) &&
      value !== "." &&
      value !== ".." &&
      !/[. ]$/.test(value) &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value),
  )
const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value) && !/[\x00\r\n]/.test(value))
const session = z
  .string()
  .max(128)
  .regex(/^ses_[A-Za-z0-9_]+$/)
const file = z
  .object({ text: z.string().max(1_048_576), digest: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict()
  .refine((value) => Buffer.byteLength(value.text, "utf8") <= 1_048_576 && sum(value.text) === value.digest)
const plan = z
  .object({ scope: z.enum(["data", "workspace"]), root: absolute, name, markdown: file, sidecar: file.optional() })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.name.endsWith(".md")) ctx.addIssue({ code: "custom", message: "Unsupported plan filename" })
    if (value.sidecar) {
      try {
        const raw = JSON.parse(value.sidecar.text)
        Schema.decodeUnknownSync(PlanArtifact.Info)(raw)
        if (
          Object.keys(raw).some((key) => !["title", "summary", "steps", "risks"].includes(key)) ||
          raw.steps.some((step: object) =>
            Object.keys(step).some(
              (key) => !["id", "description", "files", "acceptance", "status", "note"].includes(key),
            ),
          )
        )
          throw new Error("Unknown plan field")
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid structured plan" })
      }
    }
  })
const reverted = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\x00\r\n]/.test(value) && !/^[A-Za-z]:[^\\/]/.test(value))
const note = z.object({ root: absolute, session, files: z.array(reverted).min(1).max(10_000) }).strict()
const content = z.object({ plans: z.array(plan).max(10_000), reverts: z.array(note).max(10_000) }).strict()
export const notes = content
  .extend({ version: z.literal(1), history: z.array(content).max(32).default([]) })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>()
    let bytes = 0
    for (const scope of [value, ...value.history]) {
      for (const plan of scope.plans) bytes += Buffer.byteLength(JSON.stringify(plan))
      for (const note of scope.reverts) bytes += Buffer.byteLength(JSON.stringify(note))
    }
    for (const plan of value.plans) {
      const key = `plan:${plan.scope}:${identity(plan.root)}:${plan.name.toLowerCase()}`
      if (seen.has(key)) ctx.addIssue({ code: "custom", message: "Duplicate plan" })
      seen.add(key)
    }
    for (const note of value.reverts) {
      const key = `note:${identity(note.root)}:${note.session}`
      if (seen.has(key)) ctx.addIssue({ code: "custom", message: "Duplicate revert note" })
      seen.add(key)
      if (new Set(note.files).size !== note.files.length)
        ctx.addIssue({ code: "custom", message: "Duplicate reverted path" })
    }
    if (bytes > 16 * 1024 * 1024) ctx.addIssue({ code: "custom", message: "Portable notes exceed supported bytes" })
  })
type Sql = readonly { table: string; columns: readonly string[]; rows: readonly (readonly unknown[])[] }[]
function sessions(sql: Sql) {
  const table = sql.find((item) => item.table === "session")
  if (!table) throw new Error("Portable notes lack session inventory")
  return new Map(
    table.rows.map((row) => [
      session.parse(row[table.columns.indexOf("id")]),
      absolute.safeParse(row[table.columns.indexOf("directory")]).data,
    ]),
  )
}
async function present(file: string) {
  return lstat(file).catch((err: unknown) => {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined
    throw err
  })
}
async function read(file: string, maximum = 1_048_576) {
  const handle = await open(file, "r")
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) throw new Error("Unsupported portable note file")
    const bytes = await handle.readFile()
    if (bytes.length !== stat.size || bytes.length > maximum) throw new Error("Portable note file changed")
    const text = bytes.toString("utf8")
    if (!Buffer.from(text).equals(bytes)) throw new Error("Portable note is not UTF8")
    return { text, digest: sum(text) }
  } finally {
    await handle.close()
  }
}

/** Every file read is inside the active immutable Working mapping; metadata is not authority. */
export async function collectNotes(
  token: Working,
  input: { data: readonly string[]; workspaces: readonly string[]; sql: Sql },
) {
  const value = assertWorking(token)
  function mapped(file: string) {
    assertWorking(token)
    const found = value.original
      .map((root, index) => ({ root, index }))
      .filter((item) => {
        const relative = path.relative(identity(item.root.path), identity(file))
        return (
          item.root.kind === "json" &&
          (relative === "" ||
            (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)))
        )
      })
      .sort((a, b) => b.root.path.length - a.root.path.length)[0]
    if (!found) throw new Error("Portable note namespace lacks held mapping")
    return path.join(lookup(token, found.root.path), path.relative(found.root.path, file))
  }
  const rows = sessions(input.sql)
  const plans: z.infer<typeof plan>[] = []
  const reverts: z.infer<typeof note>[] = []
  const history: z.infer<typeof content>[] = []
  const budget = { bytes: 0 }
  function retain(value: unknown) {
    budget.bytes += Buffer.byteLength(JSON.stringify(value))
    if (budget.bytes > 16 * 1024 * 1024) throw new Error("Portable notes exceed supported bytes")
  }
  async function directory(file: string) {
    const stat = await present(file)
    if (!stat) return []
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsupported portable note namespace")
    const entries = await readdir(file, { withFileTypes: true })
    if (entries.length > 20_000 || entries.some((item) => !item.isFile() || item.isSymbolicLink()))
      throw new Error("Unknown portable note entry")
    return entries.map((entry) => name.parse(entry.name)).sort()
  }
  for (const root of new Set(input.data)) {
    const base = mapped(root)
    const archived = path.join(base, "restore-notes.json")
    if (await present(archived)) {
      const old = notes.parse(JSON.parse((await read(archived, 16 * 1024 * 1024)).text))
      retain(old)
      history.push(...old.history, { plans: old.plans, reverts: old.reverts })
      if (history.length > 32) throw new Error("Portable note history exceeds supported count")
    }
    const folder = path.join(base, "raya", "revert-note")
    for (const entry of await directory(folder)) {
      if (!entry.endsWith(".json")) throw new Error("Unknown revert-note entry")
      const id = session.parse(entry.slice(0, -5))
      if (!rows.has(id)) throw new Error("Revert note has no retained session")
      const value = note.parse({ root, session: id, files: JSON.parse((await read(path.join(folder, entry))).text) })
      retain(value)
      reverts.push(value)
      if (reverts.length > 10_000) throw new Error("Portable revert notes exceed supported count")
    }
  }
  for (const item of [
    ...input.data.map((root) => ({ scope: "data" as const, root, folder: path.join(mapped(root), "plans") })),
    ...input.workspaces.map((root) => ({
      scope: "workspace" as const,
      root,
      folder: path.join(mapped(root), ".kilo", "plans"),
    })),
  ]) {
    const entries = await directory(item.folder)
    for (const entry of entries) {
      if (entry.endsWith(".plan.json") && entries.includes(entry.slice(0, -10) + ".md")) continue
      if (!entry.endsWith(".md")) throw new Error("Unknown plan entry")
      const sidecar = PlanArtifact.sidecar(entry)
      const value = {
        scope: item.scope,
        root: item.root,
        name: entry,
        markdown: await read(path.join(item.folder, entry)),
        sidecar: entries.includes(sidecar) ? await read(path.join(item.folder, sidecar)) : undefined,
      }
      retain(value)
      plans.push(value)
      if (plans.length > 10_000) throw new Error("Portable plans exceed supported count")
    }
  }
  const table = input.sql.find((item) => item.table === "part")
  for (const row of table?.rows ?? []) {
    const raw = row[table!.columns.indexOf("data")]
    if (typeof raw !== "string") continue
    const part: unknown = JSON.parse(raw)
    if (!part || typeof part !== "object" || !("tool" in part) || part.tool !== "plan_exit" || !("state" in part))
      continue
    const state = z.object({ metadata: z.object({ plan: z.unknown().optional() }).optional() }).parse(part.state)
    const reference = state.metadata?.plan
    if (reference === undefined) continue
    if (typeof reference !== "string") throw new Error("Unsupported plan reference")
    const id = row[table!.columns.indexOf("session_id")]
    const workspace = typeof id === "string" ? rows.get(id) : undefined
    const file = path.isAbsolute(reference) ? reference : workspace ? path.resolve(workspace, reference) : undefined
    if (
      !file ||
      !plans.some(
        (item) =>
          identity(file) === identity(path.join(item.root, item.scope === "data" ? "plans" : ".kilo/plans", item.name)),
      )
    )
      throw new Error("Custom or external plan reference is unsupported")
  }
  assertWorking(token)
  return notes.parse({ version: 1, plans, reverts, history })
}

/** Data plans/reminders become usable; workspace plans and original identities remain inert evidence. */
export async function restoreNotes(
  raw: unknown,
  stage: string,
  destination: string,
  mapping: ReadonlyMap<string, string>,
  sql: Sql,
) {
  const value = notes.parse(raw)
  const rows = sessions(sql)
  const files = new Map<string, { file: string; text: string }>()
  function add(file: string, text: string) {
    const key = process.platform === "win32" ? file.toLowerCase() : file
    const old = files.get(key)
    if (old !== undefined && old.text !== text) throw new Error("Independent source note scopes conflict")
    files.set(key, { file, text })
  }
  const paths = [...mapping]
    .map(([source, target]) => ({ source, target }))
    .sort((a, b) => b.source.length - a.source.length)
  function remap(file: string) {
    const found = paths.find((entry) => {
      const relative = path.relative(identity(entry.source), identity(file))
      return (
        relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
      )
    })
    if (!found) throw new Error("Reverted file lacks destination workspace mapping")
    return path.join(found.target, path.relative(found.source, file))
  }
  for (const item of value.plans) {
    if (item.scope !== "data") continue
    add(path.join(stage, "plans", item.name), item.markdown.text)
    if (item.sidecar) add(path.join(stage, "plans", PlanArtifact.sidecar(item.name)), item.sidecar.text)
  }
  for (const item of value.reverts) {
    if (!rows.has(item.session)) throw new Error("Restored revert note lacks session")
    const directory = rows.get(item.session)
    const files = item.files.map((file) => {
      if (path.isAbsolute(file)) return remap(file)
      if (!directory) throw new Error("Relative reverted path lacks session directory")
      return remap(path.resolve(directory, file))
    })
    if (new Set(files.map(identity)).size !== files.length) throw new Error("Mapped reverted paths collide")
    add(path.join(stage, "raya", "revert-note", item.session + ".json"), JSON.stringify(files))
  }
  add(path.join(stage, "restore-notes.json"), JSON.stringify(value))
  for (const { file, text } of files.values()) {
    await mkdir(path.dirname(file), { recursive: true })
    const handle = await open(file, "wx", 0o600)
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  return {
    dataPlans: value.plans.filter((item) => item.scope === "data").length,
    workspacePlansInert: value.plans.filter((item) => item.scope === "workspace").length,
    reminders: value.reverts.length,
    destination,
  }
}
