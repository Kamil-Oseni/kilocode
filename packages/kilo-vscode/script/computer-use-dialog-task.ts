#!/usr/bin/env bun
// Native WinForms dialog fixture and independent state scorer. This does not drive or attest Raya.
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { inspect } from "./computer-use-installed-probe"
import { scenarios } from "./computer-use-release-gate"

const format = "raya.installed-dialog-task"
const version = 1
const scenario = "dialog-handling" satisfies (typeof scenarios)[number]
const script = join(import.meta.dir, "computer-use-dialog-task.ps1")

type Manifest = {
  format: typeof format
  version: typeof version
  scenario: typeof scenario
  runId: string
  extension: { version: string; captureSha256: string; root: string }
  createdAt: string
  code: string
  expected: "Yes" | "No"
  scriptSha256: string
}

function digest(data: Buffer | string) {
  return createHash("sha256").update(data).digest("hex")
}

function valid(input: unknown): input is Manifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  const item = input as Record<string, unknown>
  if (item.format !== format || item.version !== version || item.scenario !== scenario) return false
  if (typeof item.runId !== "string" || !/^[\da-f-]{36}$/i.test(item.runId)) return false
  if (typeof item.code !== "string" || !/^[A-F\d]{8}$/.test(item.code)) return false
  if (item.expected !== "Yes" && item.expected !== "No") return false
  if (item.expected !== (Number.parseInt(item.code[0], 16) % 2 ? "No" : "Yes")) return false
  if (typeof item.scriptSha256 !== "string" || !/^[\da-f]{64}$/i.test(item.scriptSha256)) return false
  if (!item.extension || typeof item.extension !== "object") return false
  return validExtension(item.extension)
}

function validExtension(input: object): boolean {
  const ext = input as Record<string, unknown>
  return (
    typeof ext.version === "string" &&
    typeof ext.root === "string" &&
    typeof ext.captureSha256 === "string" &&
    /^[\da-f]{64}$/i.test(ext.captureSha256)
  )
}

async function manifest(root: string) {
  if (!(await lstat(join(root, "task.json"))).isFile()) throw new Error("Invalid dialog task manifest file")
  const input = JSON.parse(await readFile(join(root, "task.json"), "utf8")) as unknown
  if (!valid(input)) throw new Error("Invalid or modified dialog task manifest")
  if (input.scriptSha256 !== digest(await readFile(script)))
    throw new Error("Dialog script differs from this task version")
  return input
}

export async function prepare(root: string, installed: string) {
  if (process.platform !== "win32") throw new Error("The installed dialog task requires Windows")
  const ext = await inspect(installed)
  const dir = resolve(root)
  await mkdir(dir, { recursive: true })
  if ((await readdir(dir)).length) throw new Error("Use an empty disposable task directory")
  const code = randomBytes(4).toString("hex").toUpperCase()
  const expected = Number.parseInt(code[0], 16) % 2 ? "No" : "Yes"
  const source = await readFile(script)
  const input: Manifest = {
    format,
    version,
    scenario,
    runId: randomUUID(),
    extension: { version: ext.version, captureSha256: ext.sha256, root: ext.root },
    createdAt: new Date().toISOString(),
    code,
    expected,
    scriptSha256: digest(source),
  }
  await writeFile(join(dir, "dialog.ps1"), source, { flag: "wx" })
  await writeFile(join(dir, "task.json"), JSON.stringify(input, null, 2), { flag: "wx" })
  return {
    manifest: input,
    workspace: dir,
    instruction: `A native Windows dialog titled "Raya dialog benchmark ${code}" will ask whether to save the draft. Select ${expected} exactly once. Do not edit files in the task directory.`,
    next: `bun computer-use-dialog-task.ts open "${dir}"`,
  }
}

async function intact(root: string, name: string, hash: string) {
  const path = join(root, name)
  return (await lstat(path)).isFile() && digest(await readFile(path)) === hash
}

function decision(data: string, input: Manifest) {
  if (!data.endsWith("\n")) return { choices: data.split("\n").filter(Boolean).length, match: false }
  const lines = data.slice(0, -1).split("\n")
  if (lines.length !== 1) return { choices: lines.length, match: false }
  try {
    const parsed = JSON.parse(lines[0]) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { choices: 1, match: false }
    const row = parsed as Record<string, unknown>
    return {
      choices: 1,
      match:
        Object.keys(row).sort().join(",") === "choice,code,dialog,runId" &&
        row.runId === input.runId &&
        row.code === input.code &&
        row.choice === input.expected &&
        row.dialog === "native-winforms-messagebox-v1",
    }
  } catch {
    return { choices: 1, match: false }
  }
}

export async function score(root: string) {
  const dir = await realpath(root)
  const input = await manifest(dir)
  const actual = (await readdir(dir)).sort()
  const expected = ["task.json", "dialog.ps1", "decision.jsonl"]
  const missing = expected.filter((name) => !actual.includes(name))
  const unexpected = actual.filter((name) => !expected.includes(name))
  const changed: string[] = []
  if (actual.includes("dialog.ps1") && !(await intact(dir, "dialog.ps1", input.scriptSha256)))
    changed.push("dialog.ps1")
  if (actual.includes("decision.jsonl") && !(await lstat(join(dir, "decision.jsonl"))).isFile())
    changed.push("decision.jsonl")
  const result =
    actual.includes("decision.jsonl") && !changed.includes("decision.jsonl")
      ? decision(await readFile(join(dir, "decision.jsonl"), "utf8"), input)
      : { choices: 0, match: false }
  if (actual.includes("decision.jsonl") && !result.match) changed.push("decision.jsonl")
  return {
    format: "raya.installed-desktop-task-result" as const,
    version,
    scenario: input.scenario,
    runId: input.runId,
    extension: input.extension,
    workspace: dir,
    correctFinalState: !missing.length && !unexpected.length && !changed.length && result.match,
    missing,
    unexpected,
    changed,
    choices: result.choices,
    replay: result.choices > 1,
    releaseGateEligible: false,
    note: "The scorer checks one persisted native dialog choice and intact fixture files. It cannot attest who acted, host reload, actions outside this folder, sensitive policy, or the complete benchmark.",
  }
}

export async function open(root: string) {
  if (process.platform !== "win32") throw new Error("Native dialog launch requires Windows")
  const result = await score(root)
  if (result.changed.length || result.unexpected.length || result.choices)
    throw new Error("The dialog task is modified or has already run")
  if (result.missing.some((name) => name !== "decision.jsonl")) throw new Error("The dialog fixture is incomplete")
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      join(result.workspace, "dialog.ps1"),
      "-Task",
      result.workspace,
    ],
    { detached: true, stdio: "ignore", windowsHide: true },
  )
  await new Promise<void>((done, fail) => {
    child.once("spawn", done)
    child.once("error", fail)
  })
  child.unref()
  return {
    status: "requested" as const,
    workspace: result.workspace,
    pid: child.pid,
    releaseGateEligible: false,
    note: "PowerShell accepted the launch request; this does not prove the dialog became visible or Raya controlled it.",
  }
}

if (import.meta.main) {
  const [cmd, root, installed] = Bun.argv.slice(2)
  if (!cmd || !root)
    throw new Error(
      "Usage: bun computer-use-dialog-task.ts prepare <empty-task-dir> <installed-extension-dir> | open <task-dir> | score <task-dir>",
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
}
