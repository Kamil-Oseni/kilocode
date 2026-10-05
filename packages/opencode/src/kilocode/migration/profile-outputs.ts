import { createHash } from "node:crypto"
import { lstat, mkdir, open, readdir } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { z } from "zod"
import * as V1 from "@opencode-ai/schema/v1/session"
import * as V2 from "@opencode-ai/schema/session-message"
import * as Event from "@opencode-ai/schema/session-event"
import { assertWorking, lookup, type Working } from "./profile-image"
import { identity } from "./profile-workspaces"

const sum = (text: string) => createHash("sha256").update(text).digest("hex")
const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine((file) => path.isAbsolute(file) && !/[\0\r\n]/.test(file))
const name = z
  .string()
  .max(128)
  .regex(/^tool_[A-Za-z0-9]+$/)
const id = z.string().min(1).max(256)
const reference = z
  .object({
    table: z.enum(["part", "session_message", "event"]),
    row: id,
    session: id,
    message: id,
    call: id,
    slot: z.number().int().min(0).max(100_000),
    index: z.number().int().min(0).max(10_000),
    path: absolute,
  })
  .strict()
const binding = reference.extend({ root: absolute, name, state: z.enum(["present", "missing"]) }).strict()
const file = z
  .object({
    root: absolute,
    name,
    text: z.string().max(8 * 1024 * 1024),
    bytes: z
      .number()
      .int()
      .min(0)
      .max(8 * 1024 * 1024),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    classification: z.enum(["referenced", "orphan"]),
  })
  .strict()
  .refine((item) => Buffer.byteLength(item.text) === item.bytes && sum(item.text) === item.digest)
const content = z.object({ files: z.array(file).max(10_000), bindings: z.array(binding).max(100_000) }).strict()
export const outputs = content
  .extend({ version: z.literal(1), history: z.array(content).max(32).default([]) })
  .strict()
  .superRefine((value, ctx) => {
    let size = 0
    for (const scope of [value, ...value.history]) {
      for (const item of scope.files) size += item.bytes
      size += Buffer.byteLength(JSON.stringify(scope.bindings))
      const seen = new Map<string, z.infer<typeof file>>()
      for (const item of scope.files) {
        const key = `${identity(item.root)}:${item.name.toLowerCase()}`
        if (seen.has(key)) ctx.addIssue({ code: "custom", message: "Duplicate portable tool output" })
        seen.set(key, item)
      }
      const keys = new Set<string>()
      const linked = new Set<string>()
      for (const item of scope.bindings) {
        const key = `${item.table}:${item.row}:${item.slot}:${item.index}`
        if (keys.has(key)) ctx.addIssue({ code: "custom", message: "Duplicate tool output binding" })
        keys.add(key)
        linked.add(`${identity(item.root)}:${item.name.toLowerCase()}`)
        if (identity(path.join(item.root, "tool-output", item.name)) !== identity(item.path))
          ctx.addIssue({ code: "custom", message: "Tool output binding escaped its namespace" })
        const found = seen.get(`${identity(item.root)}:${item.name.toLowerCase()}`)
        if ((item.state === "present") !== Boolean(found))
          ctx.addIssue({ code: "custom", message: "Tool output binding disagrees with bytes" })
      }
      for (const [key, item] of seen)
        if ((item.classification === "referenced") !== linked.has(key))
          ctx.addIssue({ code: "custom", message: "Tool output classification disagrees with references" })
    }
    if (size > 32 * 1024 * 1024)
      ctx.addIssue({ code: "custom", message: "Portable tool outputs exceed supported bytes" })
  })

type Sql = readonly { table: string; columns: readonly string[]; rows: readonly (readonly unknown[])[] }[]
const record = z.record(z.string(), z.unknown())
export function references(sql: Sql) {
  const found: z.infer<typeof reference>[] = []
  const sessions = sql.find((table) => table.table === "session")
  const ids = new Set(sessions?.rows.map((row) => id.parse(row[sessions.columns.indexOf("id")])) ?? [])
  for (const table of sql.filter((table) => ["part", "session_message", "event"].includes(table.table))) {
    for (const row of table.rows) {
      const get = (column: string) => row[table.columns.indexOf(column)]
      const raw = get("data")
      if (typeof raw !== "string") throw new Error("Portable tool output SQL lacks encoded data")
      const data = record.parse(JSON.parse(raw))
      const base = { row: id.parse(get("id")) }
      if (table.table === "part") {
        if (data.type !== "tool") continue
        const state = record.parse(data.state)
        const metadata = state.metadata === undefined ? {} : record.parse(state.metadata)
        if (metadata.outputPath === undefined) continue
        const part = Schema.decodeUnknownSync(V1.ToolPart)({
          ...data,
          id: base.row,
          sessionID: get("session_id"),
          messageID: get("message_id"),
        })
        if (part.state.status !== "completed" || metadata.truncated !== true)
          throw new Error("Unsupported V1 tool output reference")
        found.push(
          reference.parse({
            ...base,
            table: "part",
            session: part.sessionID,
            message: part.messageID,
            call: part.callID,
            slot: 0,
            index: 0,
            path: metadata.outputPath,
          }),
        )
      }
      if (table.table === "session_message" && get("type") === "assistant") {
        if (
          !Array.isArray(data.content) ||
          !data.content.some((item: unknown) => {
            const tool = record.safeParse(item).data
            return tool?.type === "tool" && record.safeParse(tool.state).data?.outputPaths !== undefined
          })
        )
          continue
        const message = Schema.decodeUnknownSync(V2.Assistant)({ ...data, type: "assistant", id: base.row })
        const encoded = z.array(record).parse(data.content)
        for (const [slot, item] of message.content.entries()) {
          if (item.type !== "tool") continue
          const state = record.parse(encoded[slot].state)
          if (state.outputPaths === undefined) continue
          if (item.state.status !== "completed") throw new Error("Unsupported V2 tool output state")
          for (const [index, file] of z.array(absolute).max(10_000).parse(state.outputPaths).entries())
            found.push(
              reference.parse({
                ...base,
                table: "session_message",
                session: get("session_id"),
                message: base.row,
                call: item.id,
                slot,
                index,
                path: file,
              }),
            )
        }
      }
      if (table.table === "event" && get("type") === Event.Tool.Success.type) {
        const event = Schema.decodeUnknownSync(Event.Tool.Success.data)(data)
        if (event.sessionID !== get("aggregate_id")) throw new Error("Tool output event aggregate mismatch")
        for (const [index, file] of z
          .array(absolute)
          .max(10_000)
          .parse(data.outputPaths ?? [])
          .entries())
          found.push(
            reference.parse({
              ...base,
              table: "event",
              session: event.sessionID,
              message: event.assistantMessageID,
              call: event.callID,
              slot: 0,
              index,
              path: file,
            }),
          )
      }
    }
  }
  if (found.length > 100_000 || found.some((item) => !ids.has(item.session)))
    throw new Error("Portable tool output lacks retained session identity")
  return found
}
async function present(file: string) {
  return lstat(file).catch((err: unknown) => {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined
    throw err
  })
}
async function read(file: string, maximum: number) {
  const handle = await open(file, "r")
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum)
      throw new Error("Unsupported portable tool output file")
    const bytes = await handle.readFile()
    if (bytes.length !== stat.size || bytes.length > maximum) throw new Error("Portable tool output changed")
    const text = bytes.toString("utf8")
    if (!Buffer.from(text).equals(bytes)) throw new Error("Portable tool output is not UTF8")
    return text
  } finally {
    await handle.close()
  }
}

/** Reads only authenticated, immutable image mappings, including injected Global data scopes. */
export async function collectOutputs(token: Working, input: { data: readonly string[]; sql: Sql }) {
  const scope = assertWorking(token)
  function mapped(file: string) {
    assertWorking(token)
    const found = scope.original
      .map((root, index) => ({ root, index }))
      .filter(({ root }) => {
        const relative = path.relative(identity(root.path), identity(file))
        return (
          root.kind === "json" &&
          (relative === "" ||
            (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)))
        )
      })
      .sort((a, b) => b.root.path.length - a.root.path.length)[0]
    if (!found) throw new Error("Tool output namespace lacks held mapping")
    return path.join(lookup(token, found.root.path), path.relative(found.root.path, file))
  }
  const roots = [...new Map(input.data.map((root) => [identity(root), absolute.parse(root)])).values()]
  const refs = references(input.sql)
  const paths = new Set(refs.map((ref) => identity(ref.path)))
  const files: z.infer<typeof file>[] = []
  const history: z.infer<typeof content>[] = []
  const budget = { bytes: 0 }
  function retain(item: unknown) {
    budget.bytes += Buffer.byteLength(JSON.stringify(item))
    if (budget.bytes > 32 * 1024 * 1024) throw new Error("Portable tool outputs exceed supported bytes")
  }
  for (const root of roots) {
    const base = mapped(root)
    const archived = path.join(base, "restore-outputs.json")
    if (await present(archived)) {
      const old = outputs.parse(JSON.parse(await read(archived, 32 * 1024 * 1024)))
      retain(old)
      history.push(...old.history, { files: old.files, bindings: old.bindings })
    }
    const directory = path.join(base, "tool-output")
    const stat = await present(directory)
    if (!stat) continue
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsupported tool output namespace")
    const entries = await readdir(directory, { withFileTypes: true })
    if (entries.length > 10_000 || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()))
      throw new Error("Unknown portable tool output entry")
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= 10_000) throw new Error("Portable tool output count exceeds supported limit")
      const filename = name.parse(entry.name)
      const text = await read(
        path.join(directory, filename),
        Math.min(8 * 1024 * 1024, 32 * 1024 * 1024 - budget.bytes),
      )
      const item = {
        root,
        name: filename,
        text,
        bytes: Buffer.byteLength(text),
        digest: sum(text),
        classification: paths.has(identity(path.join(root, "tool-output", filename)))
          ? ("referenced" as const)
          : ("orphan" as const),
      }
      retain(item)
      files.push(item)
    }
  }
  const stored = new Set(files.map((item) => `${identity(item.root)}:${item.name}`))
  const bindings = refs.map((ref) => {
    const root = roots.find((root) => identity(path.dirname(ref.path)) === identity(path.join(root, "tool-output")))
    if (!root) throw new Error("Tool output reference is outside authenticated data scopes")
    const filename = name.parse(path.basename(ref.path))
    const state = stored.has(`${identity(root)}:${filename}`) ? ("present" as const) : ("missing" as const)
    const item = { ...ref, root, name: filename, state }
    retain(item)
    return item
  })
  assertWorking(token)
  return outputs.parse({ version: 1, files, bindings, history })
}

/** Only exact shipped path fields change; prose, media and arbitrary structured output remain untouched. */
export async function restoreOutputs(raw: z.input<typeof outputs>, stage: string, destination: string, sql: Sql) {
  const value = outputs.parse(raw)
  const refs = references(sql)
  if (
    JSON.stringify(refs) !==
    JSON.stringify(value.bindings.map(({ root: _root, name: _name, state: _state, ...ref }) => ref))
  )
    throw new Error("Portable tool output bindings disagree with source SQL")
  const files = new Map<string, z.infer<typeof file>>()
  for (const item of value.files) {
    const prior = files.get(item.name.toLowerCase())
    if (prior && (prior.digest !== item.digest || prior.name !== item.name))
      throw new Error("Mapped tool output namespaces conflict")
    files.set(item.name.toLowerCase(), prior?.classification === "referenced" ? prior : item)
  }
  if (value.bindings.some((ref) => ref.state === "missing" && files.has(ref.name.toLowerCase())))
    throw new Error("Missing tool output collides with another mapped scope")
  const groups = new Map<string, z.infer<typeof binding>[]>()
  for (const ref of value.bindings) {
    const key = `${ref.table}:${ref.row}`
    const entries = groups.get(key) ?? []
    entries.push(ref)
    groups.set(key, entries)
  }
  const rewritten = sql.map((table) => ({
    ...table,
    rows: table.rows.map((row) => {
      const key = row[table.columns.indexOf("id")]
      const selected = typeof key === "string" ? groups.get(`${table.table}:${key}`) : undefined
      if (!selected) return [...row]
      const index = table.columns.indexOf("data")
      const data = record.parse(JSON.parse(z.string().parse(row[index])))
      for (const ref of selected) {
        const file = path.join(destination, "tool-output", ref.name)
        if (table.table === "part") {
          const state = record.parse(data.state)
          state.metadata = { ...record.parse(state.metadata), outputPath: file }
          data.state = state
        }
        if (table.table === "session_message") {
          const content = z.array(record).parse(data.content)
          const item = content[ref.slot]
          const state = record.parse(item.state)
          const paths = z.array(z.string()).parse(state.outputPaths)
          paths[ref.index] = file
          state.outputPaths = paths
          item.state = state
          data.content = content
        }
        if (table.table === "event") {
          const paths = z.array(z.string()).parse(data.outputPaths)
          paths[ref.index] = file
          data.outputPaths = paths
        }
      }
      const result = [...row]
      result[index] = JSON.stringify(data)
      return result
    }),
  }))
  async function write(file: string, text: string) {
    await mkdir(path.dirname(file), { recursive: true })
    const handle = await open(file, "wx", 0o600)
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  for (const item of files.values())
    await write(
      path.join(stage, item.classification === "orphan" ? "restore-tool-outputs" : "tool-output", item.name),
      item.text,
    )
  await write(path.join(stage, "restore-outputs.json"), JSON.stringify(value))
  return rewritten
}
