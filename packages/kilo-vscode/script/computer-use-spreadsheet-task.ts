#!/usr/bin/env bun
// Disposable CSV spreadsheet fixture and independent saved-cell scorer. This does not attest Excel or Raya.
import { createHash, randomInt, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { inspect } from "./computer-use-installed-probe"
import { scenarios } from "./computer-use-release-gate"

const format = "raya.installed-spreadsheet-task"
const version = 1
const scenario = "spreadsheet-editing" satisfies (typeof scenarios)[number]
const names = ["Aster", "Birch", "Cedar"] as const
const header = "Project,Units,Unit price,Extended"

type Manifest = {
  format: typeof format
  version: typeof version
  scenario: typeof scenario
  runId: string
  seed: number
  createdAt: string
  sourceSha256: string
  extension: { version: string; captureSha256: string; root: string }
}

function digest(data: Buffer | string) {
  return createHash("sha256").update(data).digest("hex")
}

function rows(seed: number) {
  return names.map((name, index) => ({
    name,
    units: seed + index * 3,
    cents: 125 + index * 75,
  }))
}

function money(cents: number) {
  return (cents / 100).toFixed(2)
}

function source(seed: number) {
  return `Project,Units,Unit price\n${rows(seed)
    .map((row) => `${row.name},${row.units},${money(row.cents)}`)
    .join("\n")}\n`
}

function initial(seed: number) {
  return `${header}\n${rows(seed)
    .map((row) => `${row.name},${row.units},${money(row.cents)},`)
    .join("\n")}\nTotal,,,\n`
}

function valid(input: unknown): input is Manifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  const item = input as Record<string, unknown>
  if (item.format !== format || item.version !== version || item.scenario !== scenario) return false
  if (typeof item.runId !== "string" || !/^[\da-f-]{36}$/i.test(item.runId)) return false
  if (!Number.isInteger(item.seed) || (item.seed as number) < 11 || (item.seed as number) > 39) return false
  if (typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))) return false
  if (item.sourceSha256 !== digest(source(item.seed as number))) return false
  if (!item.extension || typeof item.extension !== "object" || Array.isArray(item.extension)) return false
  return validExtension(item.extension)
}

function validExtension(input: object) {
  const ext = input as Record<string, unknown>
  return (
    typeof ext.version === "string" &&
    typeof ext.root === "string" &&
    typeof ext.captureSha256 === "string" &&
    /^[\da-f]{64}$/i.test(ext.captureSha256)
  )
}

async function manifest(dir: string) {
  if (!(await lstat(join(dir, "task.json"))).isFile()) throw new Error("Invalid spreadsheet task manifest")
  const input = JSON.parse(await readFile(join(dir, "task.json"), "utf8")) as unknown
  if (!valid(input)) throw new Error("Invalid or modified spreadsheet task manifest")
  return input
}

function cells(data: string) {
  // The fixture has controlled ASCII labels and no commas in values. Reject quoted or malformed CSV.
  const lines = data
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
  if (lines.at(-1) !== "") return
  lines.pop()
  if (lines.some((line) => line.includes('"') || line.includes("\r"))) return
  const parsed = lines.map((line) => line.split(","))
  if (parsed.length !== 5 || parsed.some((line) => line.length !== 4)) return
  return parsed
}

function amount(value: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) return
  const [whole, fraction = ""] = value.split(".")
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"))
  if (!Number.isSafeInteger(cents)) return
  return cents
}

function assess(seed: number, data: string) {
  const table = cells(data)
  if (!table || table[0].join(",") !== header) return { correct: false, reason: "Invalid spreadsheet shape" }
  const expected = rows(seed)
  const details = table.slice(1, 4)
  for (const [index, row] of details.entries()) {
    const goal = expected[index]
    if (row[0] !== goal.name || row[1] !== String(goal.units) || amount(row[2]) !== goal.cents)
      return { correct: false, reason: `Source inputs changed in ${goal.name}` }
    if (amount(row[3]) !== goal.units * goal.cents)
      return { correct: false, reason: `Extended value is wrong in ${goal.name}` }
  }
  const total = table[4]
  const cents = expected.reduce((sum, row) => sum + row.units * row.cents, 0)
  if (total[0] !== "Total" || total[1] !== "" || total[2] !== "" || amount(total[3]) !== cents)
    return { correct: false, reason: "The independently calculated total is wrong" }
  return { correct: true, reason: "All source cells, extended values, and total match independent arithmetic" }
}

export async function prepare(root: string, installed: string) {
  if (process.platform !== "win32") throw new Error("The installed desktop task requires Windows")
  const ext = await inspect(installed)
  const dir = resolve(root)
  await mkdir(dir, { recursive: true })
  if ((await readdir(dir)).length) throw new Error("Use an empty disposable task directory")
  const seed = randomInt(11, 40)
  const input: Manifest = {
    format,
    version,
    scenario,
    runId: randomUUID(),
    seed,
    createdAt: new Date().toISOString(),
    sourceSha256: digest(source(seed)),
    extension: { version: ext.version, captureSha256: ext.sha256, root: ext.root },
  }
  await writeFile(join(dir, "source.csv"), source(seed), { flag: "wx" })
  await writeFile(join(dir, "workbook.csv"), initial(seed), { flag: "wx" })
  await writeFile(join(dir, "task.json"), JSON.stringify(input, null, 2), { flag: "wx" })
  return {
    manifest: input,
    workspace: dir,
    instruction:
      "Open workbook.csv in a spreadsheet app. Fill each Extended cell with Units × Unit price, then fill the Total Extended cell with their sum. Save workbook.csv without changing the source inputs or adding other files. Do not edit task files through code.",
    releaseGateEligible: false,
  }
}

export async function score(root: string) {
  const dir = await realpath(root)
  const input = await manifest(dir)
  const actual = (await readdir(dir)).sort()
  const expected = ["source.csv", "task.json", "workbook.csv"]
  const missing = expected.filter((name) => !actual.includes(name))
  const unexpected = actual.filter((name) => !expected.includes(name))
  const changed: string[] = []
  for (const name of expected.filter((name) => actual.includes(name))) {
    if (!(await lstat(join(dir, name))).isFile()) changed.push(name)
  }
  if (actual.includes("source.csv") && !changed.includes("source.csv")) {
    if (digest(await readFile(join(dir, "source.csv"))) !== input.sourceSha256) changed.push("source.csv")
  }
  const data =
    actual.includes("workbook.csv") && !changed.includes("workbook.csv")
      ? await readFile(join(dir, "workbook.csv"), "utf8")
      : ""
  const verdict = assess(input.seed, data)
  return {
    format: "raya.installed-desktop-task-result" as const,
    version,
    scenario,
    runId: input.runId,
    extension: input.extension,
    workspace: dir,
    correctFinalState: !missing.length && !unexpected.length && !changed.length && verdict.correct,
    reason: verdict.reason,
    missing,
    unexpected,
    changed,
    releaseGateEligible: false,
    note: "The scorer reads saved CSV cells and independently calculates amounts. It cannot attest formulas, installed Excel use, who acted, actions outside this folder, or Raya host behavior; bind host-origin evidence before release use.",
  }
}

if (import.meta.main) {
  const [cmd, root, installed] = Bun.argv.slice(2)
  if (!root)
    throw new Error("Usage: bun computer-use-spreadsheet-task.ts <prepare|score> <task-dir> [installed-extension-dir]")
  const result =
    cmd === "prepare" && installed ? await prepare(root, installed) : cmd === "score" ? await score(root) : undefined
  if (!result) throw new Error("Unknown command or missing installed extension directory")
  console.log(JSON.stringify(result, null, 2))
  if (cmd === "score" && "correctFinalState" in result && !result.correctFinalState) process.exitCode = 2
}
