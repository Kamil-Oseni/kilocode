import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { lstat, readFile } from "node:fs/promises"
import path from "node:path"
import { formatPatch, structuredPatch } from "diff"
import { Config } from "./config"
import type { CaptureMetadata, DeltaEntry, FileEntry } from "./events"
import { isHighRiskPath } from "./worker/scrub"

type File = {
  path: string
  kind: "file" | "symlink"
  size: number
  hash: string
  content?: string
  omitted?: FileEntry["omitted"]
}

export function createWorkspaceProvider(opts: { root: string; statePath?: string; maxSnapshotBytes?: number }) {
  const state = load(opts.statePath)
  const snapshots = new Map<string, Map<string, File>>(
    Object.entries(state.snapshots).map(([key, files]) => [key, new Map(files.map((file) => [file.path, file]))]),
  )
  const owner = randomUUID()
  const seen = new Map(Object.entries(state.sessions))
  const orders = new Map<string, number>()
  let sequence = 0

  const capture = async () => {
    const result = await scan(opts.root, opts.maxSnapshotBytes ?? Config.maxSnapshotBytes)
    const files = result.files
    const id = hash(files)
    update(opts.statePath, state, (next) => {
      next.snapshots[id] = [...files.values()].map(persist)
      next.pending[id] = [...new Set([...(next.pending[id] ?? []), owner])]
    })
    snapshots.set(id, files)
    orders.set(id, ++sequence)
    return { id, files, capture: metadata(result.mode, files, result.truncated) }
  }

  return {
    current(sessionId: string): string | undefined {
      const latest = load(opts.statePath, state)
      const id = latest.sessions[sessionId]
      if (id && !snapshots.has(id)) snapshots.set(id, new Map(latest.snapshots[id].map((file) => [file.path, file])))
      if (id) seen.set(sessionId, id)
      else seen.delete(sessionId)
      return id
    },
    remember(sessionId: string, snapshotId: string): void {
      update(opts.statePath, state, (next) => {
        if (next.sessions[sessionId] !== seen.get(sessionId)) throw new Error("Workspace state changed for session")
        if (!next.snapshots[snapshotId]) throw new Error("Workspace snapshot is unavailable")
        next.sessions[sessionId] = snapshotId
        next.pending[snapshotId] = (next.pending[snapshotId] ?? []).filter((id) => id !== owner)
        if (!next.pending[snapshotId].length) delete next.pending[snapshotId]
        const selected = orders.get(snapshotId)
        if (selected !== undefined) {
          for (const [id, order] of orders) {
            if (order >= selected || !next.pending[id]) continue
            next.pending[id] = next.pending[id].filter((item) => item !== owner)
            if (!next.pending[id].length) delete next.pending[id]
          }
        }
        prune(next)
      })
      seen.set(sessionId, snapshotId)
      for (const id of snapshots.keys()) {
        if (state.snapshots[id]) continue
        snapshots.delete(id)
      }
    },
    async baseline(): Promise<{ snapshotId: string; files: FileEntry[]; capture: CaptureMetadata }> {
      const snap = await capture()
      return { snapshotId: snap.id, files: [...snap.files.values()].map(entry), capture: snap.capture }
    },
    async diff(prevSnapshotHash: string): Promise<{ snapshotHash: string; diff: DeltaEntry[] }> {
      const latest = load(opts.statePath, state)
      const saved = latest.snapshots[prevSnapshotHash]
      if (!saved) throw new Error("Workspace snapshot is unavailable")
      const prev = snapshots.get(prevSnapshotHash) ?? new Map(saved.map((file) => [file.path, file]))
      const snap = await capture()
      return { snapshotHash: snap.id, diff: delta(prev, snap.files) }
    },
  }
}

type State = {
  sessions: Record<string, string>
  snapshots: Record<string, File[]>
  pending: Record<string, string[]>
}

function prune(state: State): void {
  const used = new Set([...Object.values(state.sessions), ...Object.keys(state.pending)])
  for (const id of Object.keys(state.snapshots)) {
    if (used.has(id)) continue
    delete state.snapshots[id]
  }
}

function load(file: string | undefined, memory?: State): State {
  if (!file) return memory ?? { sessions: {}, snapshots: {}, pending: {} }
  if (!existsSync(file)) return { sessions: {}, snapshots: {}, pending: {} }
  return state(JSON.parse(readFileSync(file, "utf8")))
}

function state(value: unknown): State {
  if (!plain(value) || !plain(value.snapshots) || !plain(value.sessions)) {
    throw new Error("Invalid workspace state")
  }
  if (value.pending !== undefined && !plain(value.pending)) throw new Error("Invalid workspace pending state")
  const raw = value.snapshots
  const snapshots: Record<string, File[]> = {}
  for (const [id, files] of Object.entries(raw)) {
    if (!Array.isArray(files)) throw new Error("Invalid workspace snapshot")
    const valid = files.filter((item): item is File => file(item))
    if (valid.length !== files.length) throw new Error("Invalid workspace snapshot file")
    snapshots[id] = valid
  }
  const sessions: Record<string, string> = {}
  for (const [session, id] of Object.entries(value.sessions)) {
    if (typeof id !== "string" || !snapshots[id]) throw new Error("Invalid workspace session")
    sessions[session] = id
  }
  const pending: Record<string, string[]> = {}
  for (const [id, owners] of Object.entries(value.pending ?? {})) {
    if (!snapshots[id] || !Array.isArray(owners) || owners.some((owner) => typeof owner !== "string")) {
      throw new Error("Invalid workspace pending snapshot")
    }
    pending[id] = owners
  }
  return { sessions, snapshots, pending }
}

function file(value: unknown): value is File {
  if (!plain(value)) return false
  if (typeof value.path !== "string") return false
  if (value.kind !== "file" && value.kind !== "symlink") return false
  if (typeof value.size !== "number" || !Number.isFinite(value.size)) return false
  if (typeof value.hash !== "string") return false
  if (value.content !== undefined && typeof value.content !== "string") return false
  if (value.omitted !== undefined && !plain(value.omitted)) return false
  return true
}

function persist(file: File): File {
  return {
    path: file.path,
    kind: file.kind,
    size: file.size,
    hash: file.hash,
    omitted: file.omitted,
  }
}

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return true
}

function update(file: string | undefined, memory: State, change: (next: State) => void): void {
  if (!file) {
    change(memory)
    return
  }
  mkdirSync(path.dirname(file), { recursive: true })
  const lock = `${file}.lock`
  const deadline = Date.now() + 1_000
  let fd: number
  for (;;) {
    try {
      fd = openSync(lock, "wx")
      break
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "EEXIST") || Date.now() >= deadline) {
        throw new Error("Workspace state lock unavailable", { cause: err })
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    const next = load(file)
    change(next)
    writeFileSync(temp, JSON.stringify(next), { flag: "wx" })
    renameSync(temp, file)
    memory.sessions = next.sessions
    memory.snapshots = next.snapshots
    memory.pending = next.pending
  } finally {
    closeSync(fd)
    if (existsSync(temp)) unlinkSync(temp)
    unlinkSync(lock)
  }
}

async function scan(
  root: string,
  limit: number,
): Promise<{ files: Map<string, File>; mode: CaptureMetadata["mode"]; truncated: boolean }> {
  const repo = await repository(root)
  if (!repo) return { files: new Map(), mode: "none", truncated: false }
  const paths = await tracked(repo)
  const out = new Map<string, File>()
  const budget = { used: 0, limit, truncated: false }
  for (const item of paths) {
    const file = await inspect(repo, item, budget)
    if (file) out.set(file.path, file)
  }
  return { files: out, mode: "git-tracked-and-untracked", truncated: budget.truncated }
}

async function repository(root: string): Promise<string | undefined> {
  const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0) return
  const repo = text.trim()
  if (!repo) return
  return path.resolve(repo)
}

async function tracked(root: string): Promise<string[]> {
  const proc = Bun.spawn(["git", "ls-files", "-co", "--exclude-standard", "-z", "--", "."], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0) return []
  return Array.from(new Set(text.split("\0").filter(Boolean))).sort((a, b) => a.localeCompare(b))
}

async function inspect(
  root: string,
  rel: string,
  budget: { used: number; limit: number; truncated: boolean },
): Promise<File | undefined> {
  const full = path.join(root, rel)
  const info = await lstat(full).catch(() => undefined)
  if (!info) return undefined
  if (info.isSymbolicLink()) return { path: rel, kind: "symlink", size: info.size, hash: `symlink:${info.size}` }
  if (!info.isFile()) return undefined
  const size = info.size
  if (isHighRiskPath(rel)) {
    return { path: rel, kind: "file", size, hash: "", omitted: { reason: "high_risk_path" } }
  }
  if (size > Config.maxPayloadBytes) {
    return { path: rel, kind: "file", size, hash: "", omitted: { reason: "large" } }
  }
  if (budget.used + size > budget.limit) {
    budget.truncated = true
    return { path: rel, kind: "file", size, hash: "", omitted: { reason: "large" } }
  }
  const bytes = await readFile(full).catch(() => undefined)
  if (!bytes) return { path: rel, kind: "file", size, hash: "", omitted: { reason: "error" } }
  budget.used += size
  const hash = sha(bytes)
  if (binary(bytes)) return { path: rel, kind: "file", size, hash, omitted: { reason: "binary" } }
  return { path: rel, kind: "file", size, hash, content: bytes.toString("utf8") }
}

function binary(bytes: Buffer): boolean {
  return bytes.subarray(0, Math.min(bytes.byteLength, 8_000)).includes(0)
}

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function hash(files: Map<string, File>): string {
  const text = [...files.values()].map((file) => `${file.path}\0${file.hash}\0${file.size}`).join("\0")
  return sha(Buffer.from(text, "utf8"))
}

function entry(file: File): FileEntry {
  return {
    path: file.path,
    kind: file.kind,
    size: file.size,
    hash: file.hash || undefined,
    content: file.content,
    omitted: file.omitted,
  }
}

function metadata(mode: CaptureMetadata["mode"], files: Map<string, File>, truncated: boolean): CaptureMetadata {
  return {
    mode,
    fileCount: files.size,
    totalBytes: [...files.values()].reduce((sum, file) => sum + file.size, 0),
    omittedCountsByReason: omitted(files),
    truncated,
  }
}

function omitted(files: Map<string, File>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const file of files.values()) {
    const reason = file.omitted?.reason
    if (!reason) continue
    out[reason] = (out[reason] ?? 0) + 1
  }
  return out
}

function delta(prev: Map<string, File>, next: Map<string, File>): DeltaEntry[] {
  const paths = Array.from(new Set([...prev.keys(), ...next.keys()])).sort((a, b) => a.localeCompare(b))
  return paths.flatMap((rel) => {
    const before = prev.get(rel)
    const after = next.get(rel)
    if (!before && after) return [patch(rel, "added", "", after.content ?? "")]
    if (before && !after) return [patch(rel, "removed", before.content ?? "", "")]
    if (!before || !after || before.hash === after.hash) return []
    return [patch(rel, "modified", before.content ?? "", after.content ?? "")]
  })
}

function patch(rel: string, status: DeltaEntry["status"], before: string, after: string): DeltaEntry {
  return {
    path: rel,
    status,
    additions: lines(after),
    deletions: lines(before),
    patchChunkIds: [],
    patch: formatPatch(structuredPatch(rel, rel, before, after, "", "", { context: Number.MAX_SAFE_INTEGER })),
  }
}

function lines(text: string): number {
  if (!text) return 0
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length
}
