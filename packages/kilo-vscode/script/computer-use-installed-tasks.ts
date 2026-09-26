#!/usr/bin/env bun
// A real-app fixture and independent state scorer. This does not drive Raya or qualify a release report.
import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { promisify } from "node:util"
import { inspect } from "./computer-use-installed-probe"

const execute = promisify(execFile)
const format = "raya.installed-desktop-task"
const version = 1
const files = [
  { name: "alpha-notes.txt", folder: "Notes", data: "Raya benchmark alpha note\n" },
  { name: "beta-notes.txt", folder: "Notes", data: "Raya benchmark beta note\n" },
  { name: "quarterly-table.csv", folder: "Tables", data: "quarter,value\nQ1,17\nQ2,23\n" },
] as const

type Manifest = {
  format: typeof format
  version: typeof version
  scenario: "file-explorer-organization"
  runId: string
  extension: { version: string; captureSha256: string; root: string }
  createdAt: string
  entries: Array<{ name: string; folder: string; sha256: string }>
}

function digest(data: Buffer | string) {
  return createHash("sha256").update(data).digest("hex")
}

function valid(input: unknown): input is Manifest {
  if (!input || typeof input !== "object") return false
  const item = input as Record<string, unknown>
  if (item.format !== format || item.version !== version || item.scenario !== "file-explorer-organization") return false
  if (typeof item.runId !== "string" || !/^[\da-f-]{36}$/i.test(item.runId)) return false
  if (!item.extension || typeof item.extension !== "object") return false
  const ext = item.extension as Record<string, unknown>
  if (
    typeof ext.version !== "string" ||
    typeof ext.root !== "string" ||
    !/^[\da-f]{64}$/i.test(String(ext.captureSha256))
  )
    return false
  if (!Array.isArray(item.entries) || item.entries.length !== files.length) return false
  return item.entries.every((entry, index) => {
    if (!entry || typeof entry !== "object") return false
    const row = entry as Record<string, unknown>
    return (
      row.name === files[index].name && row.folder === files[index].folder && row.sha256 === digest(files[index].data)
    )
  })
}

export async function prepare(root: string, installed: string) {
  if (process.platform !== "win32") throw new Error("The installed desktop task requires Windows")
  const ext = await inspect(installed)
  const dir = resolve(root)
  await mkdir(dir, { recursive: true })
  if ((await readdir(dir)).length) throw new Error("Use an empty disposable task directory")
  const inbox = join(dir, "Inbox")
  await mkdir(inbox)
  for (const file of files) await writeFile(join(inbox, file.name), file.data, { flag: "wx" })
  const manifest: Manifest = {
    format,
    version,
    scenario: "file-explorer-organization",
    runId: randomUUID(),
    extension: { version: ext.version, captureSha256: ext.sha256, root: ext.root },
    createdAt: new Date().toISOString(),
    entries: files.map((file) => ({ name: file.name, folder: file.folder, sha256: digest(file.data) })),
  }
  await writeFile(join(dir, "task.json"), JSON.stringify(manifest, null, 2), { flag: "wx" })
  return {
    manifest,
    workspace: dir,
    instruction:
      "In File Explorer, move the two note files from Inbox to Notes and the CSV from Inbox to Tables. Preserve their contents. Do not create other files in this task folder.",
  }
}

async function inventory(root: string, folder = ""): Promise<string[]> {
  const path = join(root, folder)
  const entries = await readdir(path, { withFileTypes: true })
  const found: string[] = []
  for (const entry of entries) {
    const name = join(folder, entry.name)
    if (entry.isSymbolicLink()) {
      found.push(`${name}:symlink`)
      continue
    }
    if (entry.isDirectory()) {
      found.push(`${name}/`)
      found.push(...(await inventory(root, name)))
      continue
    }
    found.push(name)
  }
  return found
}

export async function score(root: string) {
  const dir = await realpath(root)
  const input = JSON.parse(await readFile(join(dir, "task.json"), "utf8")) as unknown
  if (!valid(input)) throw new Error("Invalid or modified task manifest")
  const expected = [
    "task.json",
    "Inbox/",
    "Notes/",
    "Tables/",
    ...input.entries.map((entry) => join(entry.folder, entry.name)),
  ].sort()
  const actual = (await inventory(dir)).sort()
  const missing = expected.filter((path) => !actual.includes(path))
  const unexpected = actual.filter((path) => !expected.includes(path))
  const changed: string[] = []
  for (const entry of input.entries) {
    const path = join(entry.folder, entry.name)
    if (!actual.includes(path)) continue
    if (digest(await readFile(join(dir, path))) !== entry.sha256) changed.push(path)
  }
  return {
    format: "raya.installed-desktop-task-result" as const,
    version,
    scenario: input.scenario,
    runId: input.runId,
    extension: input.extension,
    workspace: dir,
    correctFinalState: !missing.length && !unexpected.length && !changed.length,
    missing,
    unexpected,
    changed,
    releaseGateEligible: false,
    note: "The scorer checks the real disposable filesystem after File Explorer work. It cannot attest who acted, actions outside this folder, policy compliance, model metrics, host reload, or the other sixteen scenarios.",
  }
}

export async function open(root: string) {
  if (process.platform !== "win32") throw new Error("File Explorer launch requires Windows")
  const result = await score(root)
  const dir = result.workspace
  try {
    await execute("explorer.exe", [join(dir, "Inbox")], { windowsHide: true, timeout: 10_000 })
  } catch (err) {
    return {
      status: "unavailable" as const,
      reason: err instanceof Error ? err.message.slice(0, 300) : "Explorer launch failed",
      workspace: dir,
      releaseGateEligible: false,
    }
  }
  return {
    status: "requested" as const,
    workspace: dir,
    folder: join(dir, "Inbox"),
    task: basename(dir),
    releaseGateEligible: false,
    note: "Explorer accepted the launch request; this does not prove the window became foreground or Raya controlled it.",
  }
}

export type DesktopTaskDriver = {
  scenario: Manifest["scenario"]
  prepare: typeof prepare
  open: typeof open
  score: typeof score
}

export const explorerTask: DesktopTaskDriver = { scenario: "file-explorer-organization", prepare, open, score }

if (import.meta.main) {
  const [cmd, root, installed] = Bun.argv.slice(2)
  if (!cmd || !root)
    throw new Error(
      "Usage: bun computer-use-installed-tasks.ts prepare <empty-task-dir> <installed-extension-dir> | open <task-dir> | score <task-dir>",
    )
  const result =
    cmd === "prepare" && installed
      ? await prepare(root, installed)
      : cmd === "open"
        ? await open(root)
        : cmd === "score"
          ? await score(root)
          : undefined
  if (!result) throw new Error("Unknown command or missing installed extension directory")
  console.log(JSON.stringify(result, null, 2))
  if (cmd === "score" && "correctFinalState" in result && !result.correctFinalState) process.exitCode = 2
  if (cmd === "open" && "status" in result && result.status === "unavailable") process.exitCode = 2
}
