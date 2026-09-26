#!/usr/bin/env bun
// Read-only Windows Settings navigation task. It does not drive Raya or qualify a release gate.
import { createHash, randomInt, randomUUID } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { inspect } from "./computer-use-installed-probe"
import { scenarios } from "./computer-use-release-gate"

const execute = promisify(execFile)
const format = "raya.installed-settings-task"
const version = 1
const scenario = "settings-navigation" satisfies (typeof scenarios)[number]
const script = join(import.meta.dir, "computer-use-settings-task.ps1")
const pages = [
  { label: "Display", marker: "Display resolution" },
  { label: "About", marker: "Device specifications" },
  { label: "Bluetooth & devices", marker: "Add device" },
] as const

type Manifest = {
  format: typeof format
  version: typeof version
  scenario: typeof scenario
  runId: string
  extension: { version: string; captureSha256: string; root: string }
  createdAt: string
  page: number
  scriptSha256: string
}

type Observation = {
  page: string
  processPath: string
  genuineSettings: boolean
  foreground: boolean
  threadDesktop: string
  inputDesktop: string
  names: string[]
}

function digest(data: Buffer | string) {
  return createHash("sha256").update(data).digest("hex")
}

function valid(data: unknown): data is Manifest {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false
  const item = data as Record<string, unknown>
  if (item.format !== format || item.version !== version || item.scenario !== scenario) return false
  if (typeof item.runId !== "string" || !/^[\da-f-]{36}$/i.test(item.runId)) return false
  if (typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))) return false
  if (typeof item.page !== "number" || !Number.isInteger(item.page) || item.page < 0 || item.page >= pages.length)
    return false
  if (typeof item.scriptSha256 !== "string" || !/^[\da-f]{64}$/i.test(item.scriptSha256)) return false
  if (!item.extension || typeof item.extension !== "object") return false
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
  if (!(await lstat(join(dir, "task.json"))).isFile()) throw new Error("Invalid settings task manifest file")
  const data = JSON.parse(await readFile(join(dir, "task.json"), "utf8")) as unknown
  if (!valid(data)) throw new Error("Invalid or modified settings task manifest")
  if (data.scriptSha256 !== digest(await readFile(script)))
    throw new Error("Settings probe script differs from task version")
  return data
}

export async function prepare(root: string, installed: string) {
  if (process.platform !== "win32") throw new Error("The installed settings task requires Windows")
  const ext = await inspect(installed)
  const dir = resolve(root)
  await mkdir(dir, { recursive: true })
  if ((await readdir(dir)).length) throw new Error("Use an empty disposable task directory")
  const source = await readFile(script)
  const input: Manifest = {
    format,
    version,
    scenario,
    runId: randomUUID(),
    extension: { version: ext.version, captureSha256: ext.sha256, root: ext.root },
    createdAt: new Date().toISOString(),
    page: randomInt(pages.length),
    scriptSha256: digest(source),
  }
  await writeFile(join(dir, "settings-probe.ps1"), source, { flag: "wx" })
  await writeFile(join(dir, "task.json"), JSON.stringify(input, null, 2), { flag: "wx" })
  return {
    manifest: input,
    workspace: dir,
    instruction: `In the Windows Settings app, navigate from Home to ${pages[input.page].label}. Do not change any setting. Leave that page in the foreground for a read-only check.`,
    next: `bun computer-use-settings-task.ts open "${dir}"`,
  }
}

function parse(data: unknown): Observation | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return
  const item = data as Record<string, unknown>
  if (typeof item.page !== "string" || typeof item.processPath !== "string") return
  if (typeof item.genuineSettings !== "boolean" || typeof item.foreground !== "boolean") return
  if (typeof item.threadDesktop !== "string" || typeof item.inputDesktop !== "string") return
  if (!Array.isArray(item.names) || !item.names.every((name) => typeof name === "string")) return
  return item as Observation
}

export function assess(page: number, data: unknown) {
  const item = parse(data)
  if (!item || !pages[page]) return { correctFinalState: false, reason: "Invalid live Settings observation" }
  if (item.threadDesktop !== "Default" || item.inputDesktop !== "Default")
    return { correctFinalState: false, reason: "Probe is not attached to the interactive input desktop" }
  if (
    !item.foreground ||
    !item.genuineSettings ||
    !/\\ImmersiveControlPanel\\SystemSettings\.exe$/i.test(item.processPath)
  )
    return { correctFinalState: false, reason: "Foreground is not a verified Windows Settings window" }
  if (
    item.page !== pages[page].label ||
    !item.names.includes(pages[page].label) ||
    !item.names.includes(pages[page].marker)
  )
    return { correctFinalState: false, reason: "Foreground Settings page does not match the requested destination" }
  return { correctFinalState: true, reason: "Matched foreground Windows Settings page and semantic content" }
}

export async function score(root: string) {
  const dir = await realpath(root)
  const input = await manifest(dir)
  const actual = (await readdir(dir)).sort()
  const expected = ["settings-probe.ps1", "task.json"]
  const missing = expected.filter((name) => !actual.includes(name))
  const unexpected = actual.filter((name) => !expected.includes(name))
  const changed: string[] = []
  if (actual.includes("settings-probe.ps1")) {
    const path = join(dir, "settings-probe.ps1")
    if (!(await lstat(path)).isFile() || digest(await readFile(path)) !== input.scriptSha256)
      changed.push("settings-probe.ps1")
  }
  let observation: Observation | undefined
  let reason = "The probe requires an interactive Windows input desktop"
  if (process.platform === "win32" && !missing.length && !unexpected.length && !changed.length) {
    try {
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
          "-Page",
          pages[input.page].label,
        ],
        { windowsHide: true, timeout: 12_000, maxBuffer: 128_000 },
      )
      observation = parse(JSON.parse(result.stdout.trim()) as unknown)
      reason = assess(input.page, observation).reason
    } catch (err) {
      reason =
        err instanceof Error
          ? `Live Settings observation unavailable: ${err.message.slice(0, 200)}`
          : "Live Settings observation unavailable"
    }
  }
  const result = assess(input.page, observation)
  return {
    format: "raya.installed-desktop-task-result" as const,
    version,
    scenario: input.scenario,
    runId: input.runId,
    extension: input.extension,
    workspace: dir,
    correctFinalState: !missing.length && !unexpected.length && !changed.length && result.correctFinalState,
    missing,
    unexpected,
    changed,
    reason,
    releaseGateEligible: false,
    note: "A fresh read-only foreground UI Automation check is required. This partial scorer cannot attest who navigated, that Raya's installed host reloaded, actions outside Settings, policy, timing, or the complete benchmark. English semantic labels may make localized Windows ineligible.",
  }
}

export async function open(root: string) {
  if (process.platform !== "win32") throw new Error("Windows Settings launch requires Windows")
  const dir = await realpath(root)
  await manifest(dir)
  const actual = (await readdir(dir)).sort()
  if (actual.join(",") !== "settings-probe.ps1,task.json") throw new Error("Settings task directory changed")
  if (digest(await readFile(join(dir, "settings-probe.ps1"))) !== digest(await readFile(script)))
    throw new Error("Settings probe script changed")
  const child = spawn("explorer.exe", ["ms-settings:"], { detached: true, stdio: "ignore", windowsHide: true })
  await new Promise<void>((done, fail) => {
    child.once("spawn", done)
    child.once("error", fail)
  })
  child.unref()
  return {
    status: "requested" as const,
    workspace: dir,
    pid: child.pid,
    releaseGateEligible: false,
    note: "Settings Home launch was requested. This does not prove it opened in the interactive desktop or Raya navigated.",
  }
}

if (import.meta.main) {
  const [cmd, root, installed] = Bun.argv.slice(2)
  if (!cmd || !root)
    throw new Error(
      "Usage: bun computer-use-settings-task.ts prepare <empty-task-dir> <installed-extension-dir> | open <task-dir> | score <task-dir>",
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
