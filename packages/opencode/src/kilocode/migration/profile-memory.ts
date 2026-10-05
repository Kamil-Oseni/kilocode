import { z } from "zod"
import { lstat, readdir } from "node:fs/promises"
import { read as bounded } from "./profile-file"
import path from "node:path"
import { MemoryPaths } from "@kilocode/kilo-memory/paths"
import { MemorySchema } from "@kilocode/kilo-memory/schema"
import { MemoryRedact } from "@kilocode/kilo-memory/redact"
import { memoryLineage, memoryManifest, memoryPrior, memoryRecord, memoryState } from "./profile-memory-lineage"
import { memoryReview } from "./profile-memory-review"
import { createHash } from "node:crypto"
import { quarantine } from "./profile-memory-quarantine-schema"
import { readQuarantine } from "./profile-memory-quarantine"
import { quarantineLineage, readQuarantineSidecar, renderQuarantine } from "./profile-memory-quarantine-history"

const text = z
  .string()
  .max(1_048_576)
  .refine((value) => MemoryRedact.text(value) === value, "Memory contains credential-shaped content")
const session = z
  .string()
  .max(240)
  .regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.md$/)
  .refine((value) => !value.includes(".."))
export const memory = z
  .object({
    workspace: z
      .string()
      .max(4096)
      .refine((value) => path.isAbsolute(value)),
    state: z
      .string()
      .max(65_536)
      .transform((value, ctx) => {
        try {
          const raw: unknown = JSON.parse(value)
          const parsed = MemorySchema.persist(MemorySchema.parse(raw))
          return JSON.stringify({
            ...parsed,
            autoInject: !(raw && typeof raw === "object" && "autoInject" in raw && raw.autoInject === false),
          })
        } catch {
          ctx.addIssue({ code: "custom", message: "Invalid standalone memory state" })
          return z.NEVER
        }
      }),
    sources: z.object({ "project.md": text, "environment.md": text, "corrections.md": text }).strict(),
    sessions: z.array(z.object({ name: session, text }).strict()).max(10_000),
    decisions: text,
    lineage: memoryLineage.optional(),
    review: memoryReview.optional(),
    quarantine: quarantine.optional(),
    quarantineLineage: quarantineLineage.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.sessions.map((item) => item.name.toLowerCase())).size !== value.sessions.length)
      ctx.addIssue({ code: "custom", message: "Duplicate memory session filename" })
    if (value.quarantineLineage && !value.quarantine)
      ctx.addIssue({ code: "custom", message: "Memory quarantine lineage lacks its original bytes" })
    if (value.quarantine) {
      const parsed = (() => {
        try {
          renderQuarantine(value.quarantine, value.quarantineLineage)
          return true
        } catch {
          return false
        }
      })()
      if (!parsed) ctx.addIssue({ code: "custom", message: "Memory quarantine history or writer bound differs" })
    }
  })

async function read(file: string) {
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1_048_576)
    throw new Error("Unsupported standalone memory file")
  return (await bounded(file, 1_048_576)).value
}

/** Typed coordination is omitted as authority; capture ownership is verified by the caller's held image. */
async function coordination(dir: string, original = dir) {
  const info = await lstat(dir)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unverified memory coordination directory")
  const entries = await readdir(dir, { withFileTypes: true })
  if (entries.length > 2048) throw new Error("Memory coordination directory exceeds its bound")
  for (const entry of entries) {
    if (entry.name === "covered.references") {
      const file = path.join(dir, entry.name)
      const info = await lstat(file)
      if (!entry.isDirectory() || entry.isSymbolicLink() || !info.isDirectory() || info.isSymbolicLink())
        throw new Error("Unverified memory covered references")
      if ((await readdir(file)).length) throw new Error("Memory coordination operations remain")
      continue
    }
    if (!/^[0-9a-f]{40}\.(owners|writers)$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("Memory coordination contains active or unclassified state")
    const file = path.join(dir, entry.name)
    const state = await lstat(file)
    if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("Unverified memory coordination scaffold")
    const rows = await readdir(file)
    if (entry.name.endsWith(".writers") && rows.length) throw new Error("Memory coordination operations remain")
    if (rows.length > 2048) throw new Error("Memory coordination owner bound exceeded")
    for (const name of rows) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) throw new Error("Unverified memory coordination owner filename")
      const owner = path.join(file, name)
      const info = await lstat(owner)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096)
        throw new Error("Unverified memory coordination owner file")
      const value = z
        .object({
          format: z.literal("raya.profile-native-owner"),
          version: z.literal(1),
          root: z.string().max(4096),
          pid: z.number().int().positive(),
          hostname: z.string().min(1).max(255),
          token: z.string().uuid(),
        })
        .strict()
        .parse(JSON.parse((await bounded(owner, 4096)).value))
      const normalize = (file: string) =>
        process.platform === "win32" ? path.normalize(file).toLowerCase() : path.normalize(file)
      if (
        !path.isAbsolute(value.root) ||
        `${value.token}.json` !== name ||
        normalize(path.dirname(value.root)) !== normalize(path.dirname(original)) ||
        createHash("sha1")
          .update(`raya.profile.json:${normalize(value.root)}`)
          .digest("hex") +
          ".owners" !==
          entry.name
      )
        throw new Error("Memory coordination owner binding differs")
    }
  }
}

/** Validate omitted control scaffolds without accepting a live queue owner or capture gate. */
export async function scaffold(file: string, original = file) {
  if (path.basename(file) === ".raya-profile-locks") return coordination(file, original)
  if (path.basename(file) !== ".lock") throw new Error("Unclassified memory control scaffold")
  const info = await lstat(file)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unverified memory queue scaffold")
  const entries = await readdir(file, { withFileTypes: true })
  if (entries.length !== 1 || entries[0].name !== ".raya-profile-locks")
    throw new Error("Memory queue contains active or unclassified state")
  await coordination(path.join(file, ".raya-profile-locks"), path.join(original, ".raya-profile-locks"))
}

async function residue(root: string, original = root) {
  const entries = await readdir(root, { withFileTypes: true })
  if (!entries.length) return false
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) return false
    const file = path.join(root, entry.name)
    if (entry.name === ".raya-profile-locks") {
      await coordination(file, path.join(original, entry.name))
      continue
    }
    if (![".lock", "sessions"].includes(entry.name)) return false
    const children = await readdir(file, { withFileTypes: true })
    if (children.length !== 1 || children[0].name !== ".raya-profile-locks") return false
    await coordination(path.join(file, ".raya-profile-locks"), path.join(original, entry.name, ".raya-profile-locks"))
  }
  return true
}

/** Derived indexes and source-device ownership are reconstructed, never copied as authority. */
export async function memories(dir: string, original?: string) {
  const stat = await lstat(dir).catch((err: unknown) => {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined
    throw err
  })
  if (!stat) return []
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unverified standalone memory directory")
  const entries = await readdir(dir, { withFileTypes: true }).catch((err: unknown) => {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return []
    throw err
  })
  const values: z.output<typeof memory>[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Unverified standalone memory root")
    const root = path.join(dir, entry.name)
    if (entry.name === ".raya-profile-locks") {
      await coordination(root, path.join(original ?? dir, entry.name))
      continue
    }
    const initialized = await lstat(path.join(root, "manifest.json")).catch((err: unknown) => {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined
      throw err
    })
    if (!initialized && (await residue(root, path.join(original ?? dir, entry.name)))) continue
    const encoded = await read(path.join(root, "manifest.json"))
    const manifest = z
      .object({ kind: z.literal("kilo-memory"), version: z.literal(1), canonical: z.string() })
      .parse(JSON.parse(encoded))
    const id = MemoryPaths.declared(manifest.canonical)
    if (id.canonical !== manifest.canonical || id.folder !== entry.name)
      throw new Error("Standalone memory workspace identity differs")
    const files = MemoryPaths.files(root)
    const backups = await readQuarantine(root, {
      source: path.join(original ?? dir, entry.name),
      workspace: manifest.canonical,
    })
    const history = await readQuarantineSidecar(path.join(root, "restore-quarantine.json"), {
      ...(original ? { source: path.join(original, entry.name, "restore-quarantine.json") } : {}),
      workspace: manifest.canonical,
    })
    const preserved = new Map<string, z.output<typeof quarantine.element>>()
    for (const item of [...(history?.entries ?? []), ...backups]) {
      const id = item.source + ":" + item.digest
      const previous = preserved.get(id)
      if (previous && JSON.stringify(previous) !== JSON.stringify(item))
        throw new Error("Memory quarantine original identity has conflicting content")
      preserved.set(id, item)
    }
    const retained = backups.length || history ? quarantine.parse([...preserved.values()]) : undefined
    const directory = await lstat(files.sessions)
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Unverified standalone memory sessions")
    const sessions = await readdir(files.sessions, { withFileTypes: true })
    const bodies = []
    for (const item of sessions) {
      if (item.name === ".raya-profile-locks") {
        await coordination(
          path.join(files.sessions, item.name),
          path.join(original ?? dir, entry.name, "sessions", item.name),
        )
        continue
      }
      if (!item.isFile() || item.isSymbolicLink() || !session.safeParse(item.name).success)
        throw new Error("Unverified memory session file")
      bodies.push({ name: item.name, text: await read(path.join(files.sessions, item.name)) })
    }
    const decisions = await lstat(files.decisions).then(
      () => read(files.decisions),
      (err: unknown) => {
        if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return ""
        throw err
      },
    )
    const prior = await lstat(path.join(root, "restore-evidence.json")).then(
      async () => {
        const encoded = await read(path.join(root, "restore-evidence.json"))
        const value = z
          .object({ workspace: z.string(), state: z.unknown(), decisions: text, lineage: memoryLineage.optional() })
          .strict()
          .parse(JSON.parse(encoded))
        return { value, encoded }
      },
      (err: unknown) => {
        if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined
        throw err
      },
    )
    const stored = await read(files.state)
    const reviewed = await lstat(path.join(root, "restore.json")).then(
      async () => {
        const marker = await read(path.join(root, "restore.json"))
        const receipt = await read(path.resolve(dir, "../storage/raya/restore-hold.json"))
        return memoryReview.parse({
          marker: JSON.parse(marker),
          receipt: JSON.parse(receipt),
          markerText: marker,
          receiptText: receipt,
          markerDigest: createHash("sha256").update(marker).digest("hex"),
          receiptDigest: createHash("sha256").update(receipt).digest("hex"),
          activation: "inert",
        })
      },
      (err: unknown) => {
        if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined
        throw err
      },
    )
    const records = [...(prior?.value.lineage?.records ?? [])]
    if (original) {
      const source = path.join(original, entry.name)
      const state = memoryState.safeParse(JSON.parse(stored))
      if (state.success)
        records.push(memoryRecord(path.join(source, "state.json"), stored, { kind: "state", value: state.data }))
      const header = memoryManifest.safeParse(JSON.parse(encoded))
      if (header.success)
        records.push(
          memoryRecord(path.join(source, "manifest.json"), encoded, { kind: "manifest", value: header.data }),
        )
      if (prior) {
        const evidence = memoryPrior.safeParse({
          workspace: prior.value.workspace,
          state: prior.value.state,
          decisions: prior.value.decisions,
        })
        if (evidence.success)
          records.push(
            memoryRecord(path.join(source, "restore-evidence.json"), prior.encoded, {
              kind: "prior",
              value: evidence.data,
            }),
          )
      }
    }
    const unique = new Map<string, (typeof records)[number]>()
    for (const record of records) {
      const key = record.source + ":" + record.sourceDigest
      const prior = unique.get(key)
      if (prior && JSON.stringify(prior) !== JSON.stringify(record))
        throw new Error("Memory historical source has conflicting inert content")
      unique.set(key, record)
    }
    const lineage = records.length
      ? memoryLineage.parse({
          version: 1,
          records: [...unique.values()],
          activation: "inert",
        })
      : undefined
    values.push(
      memory.parse({
        workspace: manifest.canonical,
        state: stored,
        sources: {
          "project.md": await read(files.project),
          "environment.md": await read(files.environment),
          "corrections.md": await read(files.corrections),
        },
        sessions: bodies,
        decisions:
          prior?.value.decisions && decisions && prior.value.decisions !== decisions
            ? `${prior.value.decisions}\n${decisions}`
            : prior?.value.decisions || decisions,
        ...(lineage ? { lineage } : {}),
        ...(reviewed ? { review: reviewed } : {}),
        ...(retained ? { quarantine: retained } : {}),
        ...(history?.lineage ? { quarantineLineage: history.lineage } : {}),
      }),
    )
  }
  return values
}
