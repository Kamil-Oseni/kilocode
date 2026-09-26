#!/usr/bin/env bun
// Disposable File Explorer fixture and independent final-state scorer. It does not drive or attest Raya.
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { inspect } from "./computer-use-installed-probe"
import { scenarios } from "./computer-use-release-gate"

const execute = promisify(execFile)
const format = "raya.installed-desktop-drag-task"
const version = 1
const scenario = "drag-and-drop" satisfies (typeof scenarios)[number]

type Manifest = {
  format: typeof format
  version: typeof version
  scenario: typeof scenario
  runId: string
  extension: { version: string; captureSha256: string; root: string }
  createdAt: string
  source: string
  target: string
  other: string
  file: string
  payloadSha256: string
  decoySha256: string
}

function digest(data: Buffer | string) {
  return createHash("sha256").update(data).digest("hex")
}

function names(item: Record<string, unknown>) {
  return (
    typeof item.source === "string" &&
    /^Source-[\da-f]{8}$/.test(item.source) &&
    typeof item.target === "string" &&
    /^Target-[\da-f]{8}$/.test(item.target) &&
    typeof item.other === "string" &&
    /^Other-[\da-f]{8}$/.test(item.other) &&
    typeof item.file === "string" &&
    /^Move-[\da-f]{8}\.txt$/.test(item.file)
  )
}

function valid(input: unknown): input is Manifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  const item = input as Record<string, unknown>
  if (item.format !== format || item.version !== version || item.scenario !== scenario) return false
  if (typeof item.runId !== "string" || !/^[\da-f-]{36}$/i.test(item.runId)) return false
  if (!item.extension || typeof item.extension !== "object") return false
  const ext = item.extension as Record<string, unknown>
  if (typeof ext.version !== "string" || typeof ext.root !== "string") return false
  if (typeof ext.captureSha256 !== "string" || !/^[\da-f]{64}$/i.test(ext.captureSha256)) return false
  if (!names(item)) return false
  return [item.payloadSha256, item.decoySha256].every((hash) => typeof hash === "string" && /^[\da-f]{64}$/i.test(hash))
}

async function inventory(root: string, folder = ""): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
    const name = join(folder, entry.name)
    if (entry.isDirectory()) {
      found.push(`${name}/`)
      found.push(...(await inventory(root, name)))
      continue
    }
    found.push(name)
  }
  return found
}

export async function prepare(root: string, installed: string) {
  if (process.platform !== "win32") throw new Error("The installed drag task requires Windows")
  const ext = await inspect(installed)
  const dir = resolve(root)
  await mkdir(dir, { recursive: true })
  if ((await readdir(dir)).length) throw new Error("Use an empty disposable task directory")
  const source = `Source-${randomBytes(4).toString("hex")}`
  const target = `Target-${randomBytes(4).toString("hex")}`
  const other = `Other-${randomBytes(4).toString("hex")}`
  const file = `Move-${randomBytes(4).toString("hex")}.txt`
  const payload = `Raya drag task ${randomUUID()}\n`
  const decoy = `Leave this file untouched ${randomUUID()}\n`
  await Promise.all([source, target, other].map((name) => mkdir(join(dir, name))))
  await writeFile(join(dir, source, file), payload, { flag: "wx" })
  await writeFile(join(dir, other, "keep.txt"), decoy, { flag: "wx" })
  const manifest: Manifest = {
    format,
    version,
    scenario,
    runId: randomUUID(),
    extension: { version: ext.version, captureSha256: ext.sha256, root: ext.root },
    createdAt: new Date().toISOString(),
    source,
    target,
    other,
    file,
    payloadSha256: digest(payload),
    decoySha256: digest(decoy),
  }
  await writeFile(join(dir, "task.json"), JSON.stringify(manifest, null, 2), { flag: "wx" })
  return {
    manifest,
    workspace: dir,
    instruction: `In File Explorer, drag ${file} from ${source} into ${target} as a move. The source file must disappear and exactly one intact file must exist in ${target}. Leave ${other} unchanged. Do not create other files or folders in this task directory.`,
    next: `bun computer-use-drag-task.ts open "${dir}"`,
    releaseGateEligible: false,
  }
}

export async function score(root: string) {
  const dir = await realpath(root)
  const path = join(dir, "task.json")
  if (!(await lstat(path)).isFile()) throw new Error("Invalid drag task manifest file")
  const input = JSON.parse(await readFile(path, "utf8")) as unknown
  if (!valid(input)) throw new Error("Invalid or modified drag task manifest")
  const source = join(input.source, input.file)
  const target = join(input.target, input.file)
  const decoy = join(input.other, "keep.txt")
  const expected = ["task.json", `${input.source}/`, `${input.target}/`, `${input.other}/`, target, decoy].sort()
  const actual = (await inventory(dir)).sort()
  const missing = expected.filter((name) => !actual.includes(name))
  const unexpected = actual.filter((name) => !expected.includes(name))
  const changed: string[] = []
  if (actual.includes(source)) {
    const stat = await lstat(join(dir, source))
    if (!stat.isFile() || digest(await readFile(join(dir, source))) !== input.payloadSha256) changed.push(source)
  }
  if (actual.includes(target)) {
    const stat = await lstat(join(dir, target))
    if (!stat.isFile() || digest(await readFile(join(dir, target))) !== input.payloadSha256) changed.push(target)
  }
  if (actual.includes(decoy)) {
    const stat = await lstat(join(dir, decoy))
    if (!stat.isFile() || digest(await readFile(join(dir, decoy))) !== input.decoySha256) changed.push(decoy)
  }
  const duplicates: string[] = []
  for (const name of unexpected) {
    if (name === source) continue
    const stat = await lstat(join(dir, name))
    if (stat.isFile() && digest(await readFile(join(dir, name))) === input.payloadSha256) duplicates.push(name)
  }
  const extras = unexpected.filter((name) => name !== source)
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
    duplicates,
    observableExtraEffects: extras.length + changed.length,
    replayEvidence: duplicates.length > 0,
    releaseGateEligible: false,
    note: "The scorer checks the disposable filesystem for one exact move and observable extras. It cannot prove a drag gesture, who acted, invisible retries, actions outside this folder, host reload, or the full release benchmark.",
  }
}

export async function open(root: string) {
  if (process.platform !== "win32") throw new Error("File Explorer launch requires Windows")
  const result = await score(root)
  const input = JSON.parse(await readFile(join(result.workspace, "task.json"), "utf8")) as Manifest
  const source = join(input.source, input.file)
  const target = join(input.target, input.file)
  if (
    result.changed.length ||
    !result.unexpected.includes(source) ||
    !result.missing.includes(target) ||
    result.unexpected.some((name) => name !== source) ||
    result.missing.some((name) => name !== target)
  )
    throw new Error("The drag task is modified or has already run")
  const folders = [join(result.workspace, input.source), join(result.workspace, input.target)]
  for (const folder of folders) {
    try {
      await execute("explorer.exe", ["/n,", folder], { windowsHide: true, timeout: 10_000 })
    } catch (err) {
      return {
        status: "unavailable" as const,
        reason: err instanceof Error ? err.message.slice(0, 300) : "Explorer launch failed",
        requested: folder,
        releaseGateEligible: false,
      }
    }
  }
  return {
    status: "requested" as const,
    workspace: result.workspace,
    folders,
    releaseGateEligible: false,
    note: "Explorer launch requests were accepted; this does not prove both windows appeared or Raya dragged the file.",
  }
}

if (import.meta.main) {
  const [cmd, root, installed] = Bun.argv.slice(2)
  if (!cmd || !root)
    throw new Error(
      "Usage: bun computer-use-drag-task.ts prepare <empty-task-dir> <installed-extension-dir> | open <task-dir> | score <task-dir>",
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
