#!/usr/bin/env bun
// Run the native continuity checks against the executable in an extracted, installed Raya extension.
// This is a partial installed-host probe, not an autonomous-task release benchmark.
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { readFile, realpath } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

const execute = promisify(execFile)
const pattern = /^\d+\.\d+\.\d+-snapshot\+[^/\\]+$/

export async function inspect(dir: string, expected?: string) {
  const root = await realpath(dir)
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as Record<string, unknown>
  if (pkg.publisher !== "eden" || pkg.name !== "raya" || typeof pkg.version !== "string" || !pattern.test(pkg.version))
    throw new Error("Expected an extracted eden.raya Windows snapshot extension")
  const path = join(root, "bin", "raya-desktop-capture.exe")
  const input = join(root, "bin", "raya-desktop-input.exe")
  const capture = await readFile(path)
  await readFile(input)
  const sha256 = createHash("sha256").update(capture).digest("hex")
  if (expected && expected.toLowerCase() !== sha256) throw new Error("Installed native capture SHA-256 does not match")
  return { root, path, version: pkg.version, sha256 }
}

async function child(file: string, args: string[], timeout: number) {
  try {
    const result = await execute(file, args, { timeout, windowsHide: true, maxBuffer: 128_000 })
    return { status: "passed" as const, stdout: result.stdout.trim() }
  } catch (err) {
    const failure = err as Error & { code?: number | string; stdout?: string; stderr?: string }
    const code = typeof failure.stdout === "string" ? /"code":"([a-z_]+)"/.exec(failure.stdout)?.[1] : undefined
    const detail = /(?:^|\n)error: ([^\r\n]+)/.exec(failure.stderr ?? "")?.[1]
    return {
      status: "failed" as const,
      reason: code || detail?.slice(0, 300) || failure.stderr?.trim().slice(0, 300) || failure.message.slice(0, 300),
      exitCode: failure.code,
    }
  }
}

export async function probe(dir: string, expected?: string) {
  if (process.platform !== "win32") throw new Error("Installed native capture probe requires Windows")
  const installed = await inspect(dir, expected)
  const self = await child(installed.path, ["--self-test"], 20_000)
  if (self.status !== "passed")
    return {
      format: "raya.installed-native-probe",
      version: 1,
      status: "failed",
      installed,
      self,
      releaseGateEligible: false,
    }
  const script = join(import.meta.dir, "computer-use-native-foreground-test.ts")
  const foreground = await child(process.execPath, [script, installed.path], 50_000)
  const parsed = (() => {
    if (foreground.status !== "passed") return undefined
    try {
      return JSON.parse(foreground.stdout) as Record<string, unknown>
    } catch {
      return undefined
    }
  })()
  const continuity =
    parsed?.format === "raya.native-foreground-continuity" && parsed.version === 3 && parsed.status === "passed"
      ? {
          status: "passed" as const,
          epochs: parsed.epochs,
          resets: parsed.resets,
          transitionToFrameMs: parsed.transitionToFrameMs,
        }
      : {
          status: "unavailable" as const,
          reason: foreground.status === "failed" ? foreground.reason : "Invalid continuity result",
        }
  return {
    format: "raya.installed-native-probe",
    version: 1,
    status: continuity.status === "passed" ? "partial" : "unavailable",
    installed: { version: installed.version, sha256: installed.sha256, root: installed.root },
    self: { status: self.status },
    continuity,
    releaseGateEligible: false,
    note: "This checks real foreground, resize, same-HWND token replacement, and frame invalidation. It does not execute autonomous tasks or prove the extension is loaded in a live VS Code host.",
  }
}

if (import.meta.main) {
  const dir = Bun.argv[2]
  if (!dir) throw new Error("Pass the extracted, installed eden.raya extension directory [expected native SHA-256]")
  const result = await probe(dir, Bun.argv[3])
  console.log(JSON.stringify(result, null, 2))
  if (result.status !== "partial") process.exitCode = 2
}
