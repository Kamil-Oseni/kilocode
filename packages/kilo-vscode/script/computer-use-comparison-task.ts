#!/usr/bin/env bun
// Disposable real-app fixture and independent final-state scorer. It does not drive or attest Raya.
import { createHash, randomInt, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { inspect } from "./computer-use-installed-probe"
import { scenarios } from "./computer-use-release-gate"

const execute = promisify(execFile)
const format = "raya.installed-desktop-comparison-task"
const version = 1
const scenario = "multi-window-comparison" satisfies (typeof scenarios)[number]
const header = "id,value\n"
const resultHeader = "id,baseline,current,status\n"

type Manifest = {
  format: typeof format
  version: typeof version
  scenario: typeof scenario
  runId: string
  extension: { version: string; captureSha256: string; root: string }
  createdAt: string
  sources: { baseline: string; current: string }
}

function digest(data: Buffer | string) {
  return createHash("sha256").update(data).digest("hex")
}

function valid(input: unknown): input is Manifest {
  if (!input || typeof input !== "object") return false
  const item = input as Record<string, unknown>
  if (item.format !== format || item.version !== version || item.scenario !== scenario) return false
  if (typeof item.runId !== "string" || !/^[\da-f-]{36}$/i.test(item.runId)) return false
  if (!item.extension || typeof item.extension !== "object") return false
  const ext = item.extension as Record<string, unknown>
  if (typeof ext.version !== "string" || typeof ext.root !== "string") return false
  if (!/^[\da-f]{64}$/i.test(String(ext.captureSha256))) return false
  if (!item.sources || typeof item.sources !== "object") return false
  const sources = item.sources as Record<string, unknown>
  return /^[\da-f]{64}$/i.test(String(sources.baseline)) && /^[\da-f]{64}$/i.test(String(sources.current))
}

function parse(data: string) {
  if (!data.startsWith(header) || !data.endsWith("\n")) return undefined
  const rows = data.slice(header.length).trimEnd().split("\n")
  if (rows.length !== 4) return undefined
  const values = new Map<string, number>()
  for (const row of rows) {
    const match = /^(A0[1-5]),(\d{1,3})$/.exec(row)
    if (!match || values.has(match[1])) return undefined
    values.set(match[1], Number(match[2]))
  }
  return values
}

function comparison(baseline: Map<string, number>, current: Map<string, number>) {
  return (
    resultHeader +
    [...new Set([...baseline.keys(), ...current.keys()])]
      .sort()
      .map((id) => {
        const before = baseline.get(id)
        const after = current.get(id)
        const status =
          before === undefined ? "added" : after === undefined ? "removed" : before === after ? "same" : "changed"
        return `${id},${before ?? ""},${after ?? ""},${status}\n`
      })
      .join("")
  )
}

async function inventory(root: string, folder = ""): Promise<string[]> {
  const entries = await readdir(join(root, folder), { withFileTypes: true })
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

export async function prepare(root: string, installed: string) {
  if (process.platform !== "win32") throw new Error("The installed desktop task requires Windows")
  const ext = await inspect(installed)
  const dir = resolve(root)
  await mkdir(dir, { recursive: true })
  if ((await readdir(dir)).length) throw new Error("Use an empty disposable task directory")
  const seed = randomInt(10, 90)
  const baseline = `${header}A01,${seed}\nA02,${seed + 2}\nA03,${seed + 4}\nA04,${seed + 6}\n`
  const current = `${header}A01,${seed}\nA02,${seed + 3}\nA04,${seed + 6}\nA05,${seed + 8}\n`
  await mkdir(join(dir, "Baseline"))
  await mkdir(join(dir, "Current"))
  await mkdir(join(dir, "Working"))
  await writeFile(join(dir, "Baseline", "accounts.csv"), baseline, { flag: "wx" })
  await writeFile(join(dir, "Current", "accounts.csv"), current, { flag: "wx" })
  const manifest: Manifest = {
    format,
    version,
    scenario,
    runId: randomUUID(),
    extension: { version: ext.version, captureSha256: ext.sha256, root: ext.root },
    createdAt: new Date().toISOString(),
    sources: { baseline: digest(baseline), current: digest(current) },
  }
  await writeFile(join(dir, "task.json"), JSON.stringify(manifest, null, 2), { flag: "wx" })
  return {
    manifest,
    workspace: dir,
    instruction:
      "Use the Baseline and Current File Explorer windows. Copy Baseline\\accounts.csv into Working without changing either source. Compare the two CSV files and create Working\\comparison.csv with the header id,baseline,current,status, one row per account ID in ascending order, and status same, changed, removed, or added. Use an empty field for a missing value. Do not create any other files or folders in this task directory.",
  }
}

export async function score(root: string) {
  const dir = await realpath(root)
  const input = JSON.parse(await readFile(join(dir, "task.json"), "utf8")) as unknown
  if (!valid(input)) throw new Error("Invalid or modified task manifest")
  const expected = [
    "task.json",
    "Baseline/",
    "Current/",
    "Working/",
    join("Baseline", "accounts.csv"),
    join("Current", "accounts.csv"),
    join("Working", "accounts.csv"),
    join("Working", "comparison.csv"),
  ].sort()
  const actual = (await inventory(dir)).sort()
  const missing = expected.filter((path) => !actual.includes(path))
  const unexpected = actual.filter((path) => !expected.includes(path))
  const changed = await verify(dir, actual, input)
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
    note: "The scorer checks the real disposable filesystem after the multi-window task. It cannot attest who acted, whether two windows appeared, actions outside this folder, policy compliance, model metrics, host reload, or the other benchmark scenarios.",
  }
}

async function verify(dir: string, actual: string[], input: Manifest) {
  const changed: string[] = []
  const source = join("Baseline", "accounts.csv")
  const target = join("Current", "accounts.csv")
  const baseline = actual.includes(source) ? await readFile(join(dir, source)) : undefined
  const current = actual.includes(target) ? await readFile(join(dir, target)) : undefined
  if (baseline && digest(baseline) !== input.sources.baseline) changed.push(source)
  if (current && digest(current) !== input.sources.current) changed.push(target)
  const left = baseline ? parse(baseline.toString("utf8")) : undefined
  const right = current ? parse(current.toString("utf8")) : undefined
  const copied = join("Working", "accounts.csv")
  if (actual.includes(copied) && digest(await readFile(join(dir, copied))) !== input.sources.baseline)
    changed.push(copied)
  const output = join("Working", "comparison.csv")
  if (actual.includes(output)) {
    const data = (await readFile(join(dir, output), "utf8")).replaceAll("\r\n", "\n")
    if (!left || !right || data !== comparison(left, right)) changed.push(output)
  }
  return changed
}

export async function open(root: string) {
  if (process.platform !== "win32") throw new Error("File Explorer launch requires Windows")
  const result = await score(root)
  const folders = [join(result.workspace, "Baseline"), join(result.workspace, "Current")]
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
    note: "Two Explorer launch requests were accepted; this does not prove two windows appeared or Raya controlled them.",
  }
}

if (import.meta.main) {
  const [cmd, root, installed] = Bun.argv.slice(2)
  if (!cmd || !root)
    throw new Error(
      "Usage: bun computer-use-comparison-task.ts prepare <empty-task-dir> <installed-extension-dir> | open <task-dir> | score <task-dir>",
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
