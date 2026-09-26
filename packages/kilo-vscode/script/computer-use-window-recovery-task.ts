#!/usr/bin/env bun
// Disposable native-window recovery task; its score is not release-gate evidence.
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { inspect } from "./computer-use-installed-probe"
import { scenarios } from "./computer-use-release-gate"

const execute = promisify(execFile)
const format = "raya.installed-window-recovery-task"
const version = 1
const scenario = "moved-resized-window-recovery" satisfies (typeof scenarios)[number]
const script = join(import.meta.dir, "computer-use-window-recovery-task.ps1")

type Manifest = {
  format: typeof format
  version: typeof version
  scenario: typeof scenario
  runId: string
  createdAt: string
  code: string
  expected: "North" | "South"
  scriptSha256: string
  extension: { version: string; captureSha256: string; root: string }
}

type Observation = {
  threadDesktop: string
  inputDesktop: string
  title: string
  pid: number
  processPath: string
  foreground: boolean
  bounds: number[]
  names: string[]
}

type Interruption = { runId: string; pid: number; before: number[]; after: number[]; at: string }

function digest(data: Buffer | string) {
  return createHash("sha256").update(data).digest("hex")
}

function rect(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === 4 && value.every((item) => Number.isSafeInteger(item))
}

function valid(input: unknown): input is Manifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  const item = input as Record<string, unknown>
  if (item.format !== format || item.version !== version || item.scenario !== scenario) return false
  if (typeof item.runId !== "string" || !/^[\da-f-]{36}$/i.test(item.runId)) return false
  if (typeof item.code !== "string" || !/^[A-F\d]{8}$/.test(item.code)) return false
  if (item.expected !== (Number.parseInt(item.code[0], 16) % 2 ? "South" : "North")) return false
  if (typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))) return false
  if (typeof item.scriptSha256 !== "string" || !/^[\da-f]{64}$/i.test(item.scriptSha256)) return false
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

function parse(input: unknown): Observation | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  const item = input as Record<string, unknown>
  if (typeof item.threadDesktop !== "string" || typeof item.inputDesktop !== "string") return
  if (typeof item.title !== "string" || typeof item.processPath !== "string") return
  if (!Number.isSafeInteger(item.pid) || (item.pid as number) <= 0 || typeof item.foreground !== "boolean") return
  if (!rect(item.bounds) || !Array.isArray(item.names) || !item.names.every((name) => typeof name === "string")) return
  return item as Observation
}

function interruption(input: unknown): Interruption | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  const item = input as Record<string, unknown>
  if (typeof item.runId !== "string" || !Number.isSafeInteger(item.pid) || (item.pid as number) <= 0) return
  if (!rect(item.before) || !rect(item.after)) return
  if (typeof item.at !== "string" || !Number.isFinite(Date.parse(item.at))) return
  return item as Interruption
}

async function manifest(dir: string) {
  if (!(await lstat(join(dir, "task.json"))).isFile()) throw new Error("Invalid recovery task manifest file")
  const input = JSON.parse(await readFile(join(dir, "task.json"), "utf8")) as unknown
  if (!valid(input)) throw new Error("Invalid or modified recovery task manifest")
  if (input.scriptSha256 !== digest(await readFile(script))) throw new Error("Recovery probe script changed")
  return input
}

export function assess(input: Pick<Manifest, "runId" | "code" | "expected">, event: unknown, data: unknown) {
  const scene = parse(data)
  const move = interruption(event)
  if (!scene) return { correctFinalState: false, reason: "No valid live Win32/UI Automation observation" }
  if (scene.threadDesktop !== "Default" || scene.inputDesktop !== "Default")
    return { correctFinalState: false, reason: "Probe is not on the interactive input desktop" }
  if (!move || move.runId !== input.runId || move.pid !== scene.pid)
    return { correctFinalState: false, reason: "No matching external interruption for this live window" }
  if (move.before.join(",") === move.after.join(",") || move.after.join(",") !== scene.bounds.join(","))
    return { correctFinalState: false, reason: "The window did not remain at the confirmed moved and resized bounds" }
  if (move.before[0] === move.after[0] || move.before[1] === move.after[1])
    return { correctFinalState: false, reason: "The external interruption did not move both axes" }
  if (move.before[2] === move.after[2] || move.before[3] === move.after[3])
    return { correctFinalState: false, reason: "The external interruption did not resize both axes" }
  if (
    !scene.foreground ||
    scene.title !== `Raya window recovery ${input.code}` ||
    !/\\powershell\.exe$/i.test(scene.processPath)
  )
    return { correctFinalState: false, reason: "The exact native fixture is not foreground" }
  if (!scene.names.includes(`Selected ${input.expected}; selections 1`))
    return { correctFinalState: false, reason: "The randomized target was not selected exactly once" }
  if (
    scene.names.includes("Pending; selections 0") ||
    scene.names.some((name) => /; selections (?:[2-9]|[1-9]\d+)$/.test(name))
  )
    return { correctFinalState: false, reason: "The native fixture recorded no effect or a duplicate effect" }
  if (
    scene.names.some(
      (name) =>
        /^Selected (North|South); selections 1$/.test(name) && name !== `Selected ${input.expected}; selections 1`,
    )
  )
    return { correctFinalState: false, reason: "The wrong native target was selected" }
  return {
    correctFinalState: true,
    reason: "Live UI Automation matches one randomized selection after confirmed external move and resize",
  }
}

async function probe(dir: string, mode: "interrupt" | "inspect") {
  const result = await execute(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-Mode",
      mode,
      "-Task",
      dir,
    ],
    { windowsHide: true, timeout: 15_000, maxBuffer: 128_000 },
  )
  return JSON.parse(result.stdout.trim()) as unknown
}

export async function prepare(root: string, installed: string) {
  if (process.platform !== "win32") throw new Error("The native recovery task requires Windows")
  const ext = await inspect(installed)
  const dir = resolve(root)
  await mkdir(dir, { recursive: true })
  if ((await readdir(dir)).length) throw new Error("Use an empty disposable task directory")
  const code = randomBytes(4).toString("hex").toUpperCase()
  const input: Manifest = {
    format,
    version,
    scenario,
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    code,
    expected: Number.parseInt(code[0], 16) % 2 ? "South" : "North",
    scriptSha256: digest(await readFile(script)),
    extension: { version: ext.version, captureSha256: ext.sha256, root: ext.root },
  }
  await writeFile(join(dir, "window-recovery.ps1"), await readFile(script), { flag: "wx" })
  await writeFile(join(dir, "task.json"), JSON.stringify(input, null, 2), { flag: "wx" })
  return {
    manifest: input,
    workspace: dir,
    instruction: `Observe the foreground native window titled Raya window recovery ${code}. After the external move and resize, take a fresh observation and select ${input.expected} ${code} exactly once. Leave the window open and foreground.`,
    releaseGateEligible: false,
  }
}

export async function open(root: string) {
  if (process.platform !== "win32") throw new Error("Native recovery launch requires Windows")
  const dir = await realpath(root)
  const input = await manifest(dir)
  if ((await readdir(dir)).sort().join(",") !== "task.json,window-recovery.ps1")
    throw new Error("The recovery task is modified or already interrupted")
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-Mode",
      "launch",
      "-Task",
      dir,
    ],
    { detached: true, stdio: "ignore", windowsHide: false },
  )
  child.unref()
  return { runId: input.runId, pid: child.pid, title: `Raya window recovery ${input.code}`, releaseGateEligible: false }
}

export async function interrupt(root: string) {
  if (process.platform !== "win32") throw new Error("Native recovery interruption requires Windows")
  const dir = await realpath(root)
  await manifest(dir)
  return { observation: parse(await probe(dir, "interrupt")), releaseGateEligible: false }
}

export async function score(root: string, observed?: unknown) {
  const dir = await realpath(root)
  const input = await manifest(dir)
  const actual = (await readdir(dir)).sort()
  const expected = ["interrupt.json", "task.json", "window-recovery.ps1"]
  const missing = expected.filter((name) => !actual.includes(name))
  const unexpected = actual.filter((name) => !expected.includes(name))
  const changed: string[] = []
  if (actual.includes("window-recovery.ps1")) {
    const path = join(dir, "window-recovery.ps1")
    if (!(await lstat(path)).isFile() || digest(await readFile(path)) !== input.scriptSha256)
      changed.push("window-recovery.ps1")
  }
  const event = actual.includes("interrupt.json")
    ? interruption(JSON.parse(await readFile(join(dir, "interrupt.json"), "utf8")) as unknown)
    : undefined
  const data =
    observed === undefined && process.platform === "win32"
      ? await probe(dir, "inspect").catch(() => undefined)
      : observed
  const verdict = assess(input, event, data)
  return {
    format: "raya.installed-desktop-task-result" as const,
    version,
    scenario,
    runId: input.runId,
    extension: input.extension,
    workspace: dir,
    correctFinalState: !missing.length && !unexpected.length && !changed.length && verdict.correctFinalState,
    reason: verdict.reason,
    missing,
    unexpected,
    changed,
    releaseGateEligible: false,
    note: "Live Win32/UIA and fixture evidence do not prove Raya observed before interruption, who acted, or that no stale click landed outside the fixture. Bind host-origin receipts before using this for release evidence.",
  }
}

if (import.meta.main) {
  const [command, root, installed] = process.argv.slice(2)
  if (!root || !["prepare", "open", "interrupt", "score"].includes(command ?? "")) {
    console.error(
      "Usage: bun computer-use-window-recovery-task.ts <prepare|open|interrupt|score> <empty task dir> [installed extension dir]",
    )
    process.exit(2)
  }
  const result = await (command === "prepare"
    ? prepare(root, installed ?? "")
    : command === "open"
      ? open(root)
      : command === "interrupt"
        ? interrupt(root)
        : score(root))
  console.log(JSON.stringify(result, null, 2))
}
