import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { unseal } from "../../../src/kilocode/migration/profile-bundle"
import { restore } from "../../../src/kilocode/migration/profile-restore"
import { identity } from "../../../src/kilocode/migration/profile-workspaces"
import { finish } from "../../../src/kilocode/cli/finish"

const state = { stage: "input", checks: 0 }
const confidential: { password?: string } = {}
const [file, directory] = process.argv.slice(2)
if (!file || !directory || !path.isAbsolute(file) || !path.isAbsolute(directory))
  throw new Error("Restore fixture requires encrypted path and private destination base")
const base = await realpath(directory)
if (base !== directory || !(await lstat(base)).isDirectory()) throw new Error("Restore fixture base must be physical")
const receipt = path.join(base, "source-export-restore-receipt.json")

try {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > 4096) throw new Error("Restore fixture private stdin exceeded bound")
    chunks.push(bytes)
  }
  const secret = z
    .object({ password: z.string().min(12).max(1024), secondHop: z.boolean().optional() })
    .strict()
    .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")))
  confidential.password = secret.password
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 180 * 1024 * 1024)
    throw new Error("Restore fixture encrypted input is not bounded unique file")
  const text = await readFile(file, "utf8")
  const original = await unseal(text, secret.password)
  state.stage = "mapping"
  const target = path.join(base, "restored-profile")
  const mappings: Record<string, string> = {}
  const primaries: string[] = []
  for (const [index, source] of original.workspaces.entries()) {
    const managed = original.artifacts?.worktrees.find((tree) => identity(tree.workspace) === identity(source))
    if (managed) {
      mappings[source] = path.join(target, "data", "kilo", "worktree", managed.project, managed.name)
      continue
    }
    const destination = path.join(base, "workspaces", String(index))
    await mkdir(destination, { recursive: true })
    mappings[source] = await realpath(destination)
    if (
      original.artifacts?.repositories.some((repo) => repo.workspace && identity(repo.workspace) === identity(source))
    )
      primaries.push(source)
  }
  state.stage = "restore"
  const restored = await restore(text, secret.password, target, mappings, {
    primaries,
    helper: process.env.RAYA_TEST_DIRECTORY_HELPER,
  })
  const verified = await (await import("./profile-imported-assert")).verify(original, restored, mappings, primaries)
  state.checks += verified.checks
  state.stage = "complete"
  const result = {
    format: "raya.source-export-restore-fixture",
    version: 1,
    passed: true,
    checks: state.checks,
    path: restored.path,
    sessions: verified.sessions,
    host: !!original.host,
    held: true,
    reconnect: true,
    noReplay: true,
    trees: verified.trees,
    secondExportAttempted: secret.secondHop === true,
    ...(secret.secondHop && original.config
      ? {
          secondHop: await (
            await import("./source-config-second-hop")
          ).roundtrip(
            original.config,
            restored,
            base,
            secret.password,
            original.disposition,
            original.memory,
            original.json,
            original.voice,
            original.composers,
            original.operational,
            original,
          ),
        }
      : {}),
    completeProfileCoverage: false,
    portableCaptureAuthorized: false,
    finishRequested: true,
  }
  await writeFile(receipt, JSON.stringify(result), { flag: "wx", mode: 0o600 })
  process.stdout.write(`SOURCE_EXPORT_RESTORE_RECEIPT ${JSON.stringify(result)}\n`)
} catch (err) {
  process.exitCode = 1
  const message =
    confidential.password && err instanceof Error
      ? err.message.split(confidential.password).join("[redacted]").slice(0, 2048)
      : "Private restore fixture input refused"
  await writeFile(
    receipt,
    JSON.stringify({
      format: "raya.source-export-restore-fixture",
      version: 1,
      passed: false,
      stage: state.stage,
      checks: state.checks,
      reason: message,
      portableCaptureAuthorized: false,
    }),
    { flag: "wx", mode: 0o600 },
  )
  process.stderr.write(`Private source export restore refused at ${state.stage}; receipt retained\n`)
} finally {
  await finish([])
}
