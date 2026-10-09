import path from "node:path"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readFile, realpath, writeFile } from "node:fs/promises"

/** Observe Bun.build inside its original compiler process; parent retirement remains a separate receipt. */
export async function begin(target: string, recipe: Record<string, unknown>) {
  const dir = process.env.RAYA_CLI_COMPILER_EVIDENCE
  if (!dir) return undefined
  if (!path.isAbsolute(dir) || path.resolve(await realpath(dir)) !== path.resolve(dir))
    throw new Error("Compiler evidence directory is redirected")
  const before = JSON.parse(await readFile(path.join(dir, "source-before.json"), "utf8")) as { input?: unknown }
  if (typeof before.input !== "string" || !/^[a-f0-9]{64}$/.test(before.input))
    throw new Error("Original compiler source evidence is missing")
  const value = {
    format: "raya.cli.bun-build-phase.v1",
    pid: process.pid,
    parent: process.ppid,
    argv: process.argv,
    cwd: process.cwd(),
    interpreter: process.execPath,
    target,
    source: before.input,
    recipe,
    api: "Bun.build",
    processLocal: true,
    familyJoinsObserved: false,
  }
  await writeFile(path.join(dir, "phase-start.json"), JSON.stringify(value), { flag: "wx" })
  return { dir, value }
}

export async function finish(
  phase: Awaited<ReturnType<typeof begin>>,
  result: Pick<Bun.BuildOutput, "success" | "logs">,
  output: string,
) {
  if (!phase) return
  const before = await lstat(output, { bigint: true })
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    path.resolve(await realpath(output)) !== path.resolve(output)
  )
    throw new Error("Actual compiler output is not ordinary")
  const hash = createHash("sha256")
  let bytes = 0
  for await (const raw of createReadStream(output)) {
    bytes += raw.length
    if (bytes > 1073741824) throw new Error("Compiler output exceeds its observation bound")
    hash.update(raw)
  }
  const after = await lstat(output, { bigint: true })
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    BigInt(bytes) !== after.size
  )
    throw new Error("Compiler output changed during observation")
  await writeFile(
    path.join(phase.dir, "phase-complete.json"),
    JSON.stringify({
      ...phase.value,
      succeeded: result.success,
      logs: result.logs.length,
      output: { path: output, bytes, sha256: hash.digest("hex") },
      compilerProcessExitObserved: false,
    }),
    { flag: "wx" },
  )
}
