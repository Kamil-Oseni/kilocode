#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { openPromise } from "yauzl"
import { verify } from "../src/services/update-vsix"

const root = path.resolve(import.meta.dir, "../../..")
const dir = path.join(root, "packages/kilo-vscode")
const out = path.join(dir, "out")
const hosts: Record<string, { os: string; arch: string; cli: string }> = {
  "win32-x64": { os: "win32", arch: "x64", cli: "extension/bin/kilo.exe" },
  "darwin-arm64": { os: "darwin", arch: "arm64", cli: "extension/bin/kilo" },
  "linux-x64": { os: "linux", arch: "x64", cli: "extension/bin/kilo" },
}

const checks = [
  { id: "support", cmd: ["run", "script/kilocode/raya-support.ts"], cwd: root },
  { id: "architecture", cmd: ["run", "script/check-architecture.ts"], cwd: root },
  { id: "workflows", cmd: ["run", "script/check-workflows.ts"], cwd: root },
  { id: "test-inventory", cmd: ["run", "script/check-test-ci.ts"], cwd: root },
  { id: "generated-state", cmd: ["run", "script/check-kilo-generated-artifacts.ts"], cwd: root },
  { id: "effect-facades", cmd: ["run", "script/check-opencode-promise-facades.ts"], cwd: root },
  { id: "changesets", cmd: ["x", "changeset", "status"], cwd: root },
  {
    id: "migrations",
    cmd: [
      "test",
      "./test/database-migration.test.ts",
      "./test/kilocode/database-migration-compat.test.ts",
      "./test/kilocode/migration-backup.test.ts",
      "./test/kilocode/routine-migration.test.ts",
    ],
    cwd: path.join(root, "packages/core"),
  },
] as const

export function version(value: string) {
  const parsed = value
    .trim()
    .replace(/^raya-/, "")
    .replace(/^v/, "")
    .replace(/[-+].*$/, "")
  if (!/^\d+\.\d+\.\d+$/.test(parsed)) throw new Error("RAYA_RELEASE_VERSION must identify an x.y.z release.")
  return parsed
}

export function platform(target: string, os = process.platform, arch = process.arch) {
  const host = hosts[target]
  if (!host) throw new Error(`Unsupported Raya release target: ${target || "missing"}.`)
  if (host.os !== os || host.arch !== arch)
    throw new Error(`Target ${target} requires ${host.os}/${host.arch}; this runner is ${os}/${arch}.`)
  return host
}

export function plan() {
  return checks.map((step) => ({
    id: step.id,
    command: ["bun", ...step.cmd].join(" "),
    cwd: path.relative(root, step.cwd).replaceAll("\\", "/") || ".",
  }))
}

async function git(...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe", windowsHide: true })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(stderr.trim() || `git ${args.join(" ")} failed.`)
  return stdout.trim()
}

async function execute(step: (typeof checks)[number] | { id: string; cmd: readonly string[]; cwd: string }) {
  const startedAt = new Date().toISOString()
  const started = performance.now()
  console.log(`\n[release-evidence] ${step.id}: bun ${step.cmd.join(" ")}`)
  const child = Bun.spawn([process.execPath, ...step.cmd], {
    cwd: step.cwd,
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
    windowsHide: true,
  })
  const exitCode = await child.exited
  return {
    id: step.id,
    command: ["bun", ...step.cmd].join(" "),
    cwd: path.relative(root, step.cwd).replaceAll("\\", "/") || ".",
    startedAt,
    durationMs: Math.round(performance.now() - started),
    exitCode,
    status: exitCode === 0 ? ("passed" as const) : ("failed" as const),
  }
}

async function digest(file: string) {
  const hash = createHash("sha256")
  for await (const chunk of Bun.file(file).stream()) hash.update(chunk)
  return hash.digest("hex")
}

export async function inspect(file: string, target: string, release: string) {
  await verify(file, { name: "raya", publisher: "eden", version: release, target })
  const zip = await openPromise(file, { strictFileNames: true, autoClose: false })
  const host = hosts[target]!
  let entries = 0
  let cli = 0
  let sensitive = 0
  try {
    for await (const entry of zip.eachEntry()) {
      entries++
      if (entry.fileName === host.cli) cli = entry.uncompressedSize
      if (/(^|\/)(\.env($|\.)|[^/]*\.tmp$)/i.test(entry.fileName)) sensitive++
    }
  } finally {
    zip.close()
  }
  if (!entries || !cli) throw new Error("Release archive is missing its bundled CLI or has no entries.")
  if (sensitive) throw new Error("Release archive contains .env or .tmp files.")
  return {
    path: path.relative(root, file).replaceAll("\\", "/"),
    bytes: Bun.file(file).size,
    sha256: await digest(file),
    entries,
    cliBytes: cli,
    sensitiveEntries: sensitive,
    identity: { publisher: "eden", name: "raya", version: release, target },
  }
}

async function save(file: string, value: unknown) {
  await Bun.write(file, JSON.stringify(value, null, 2) + "\n")
  console.log(`\n[release-evidence] wrote ${path.relative(root, file)}`)
}

async function main() {
  const args = Bun.argv.slice(2)
  if (args.length) {
    if (args.length === 1 && args[0] === "--plan") {
      console.log(JSON.stringify({ version: 1, checks: plan() }, null, 2))
      return
    }
    throw new Error("Usage: release-evidence.ts [--plan]")
  }

  const target = process.env.RAYA_VSCE_TARGET?.trim() ?? ""
  const release = version(process.env.RAYA_RELEASE_VERSION ?? "")
  platform(target)
  const commit = await git("rev-parse", "HEAD")
  const dirty = await git("status", "--porcelain", "--untracked-files=no")
  if (dirty) throw new Error("Release evidence requires a clean tracked worktree.")
  await mkdir(out, { recursive: true })
  const file = path.join(out, `raya-${target}.evidence.json`)
  const results: Array<Record<string, unknown>> = []
  const base = {
    version: 1,
    source: { commit, trackedWorktree: "clean" },
    host: { platform: process.platform, arch: process.arch, bun: Bun.version },
    target,
    release,
    generatedAt: new Date().toISOString(),
    checks: results,
    installation: {
      status: "not-run",
      reason:
        "The native build runner packages and verifies the artifact; clean installation is recorded separately per supported platform.",
    },
    rollback: { status: "documented", record: "docs/Raya-Release-And-Auto-Update.md#rollback" },
  }
  for (const step of checks) {
    const result = await execute(step)
    results.push(result)
    if (result.status === "failed") {
      await save(file, { ...base, artifact: null })
      process.exitCode = 1
      return
    }
  }
  const built = await execute({ id: "package", cmd: ["run", "snapshot:release"], cwd: dir })
  results.push(built)
  if (built.status === "failed") {
    await save(file, { ...base, artifact: null })
    process.exitCode = 1
    return
  }
  const inspected = await Promise.allSettled([inspect(path.join(out, `raya-${target}.vsix`), target, release)])
  const result = inspected[0]!
  if (result.status === "rejected") {
    results.push({
      id: "artifact",
      command: "inspect packaged VSIX",
      cwd: "packages/kilo-vscode",
      durationMs: 0,
      exitCode: 1,
      status: "failed",
      reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
    })
    await save(file, { ...base, artifact: null })
    process.exitCode = 1
    return
  }
  const artifact = result.value
  results.push({
    id: "artifact",
    command: "inspect packaged VSIX",
    cwd: "packages/kilo-vscode",
    durationMs: 0,
    exitCode: 0,
    status: "passed",
  })
  const drift = await git("status", "--porcelain", "--untracked-files=no")
  results.push({
    id: "source-drift",
    command: "git status --porcelain --untracked-files=no",
    cwd: ".",
    durationMs: 0,
    exitCode: drift ? 1 : 0,
    status: drift ? "failed" : "passed",
  })
  await save(file, { ...base, artifact })
  if (drift) process.exitCode = 1
}

if (import.meta.main) await main()
