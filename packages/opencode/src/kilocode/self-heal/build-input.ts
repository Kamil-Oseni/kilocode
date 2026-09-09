import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { Snapshot, unchanged } from "./snapshot"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const Build = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
  itemID: Schema.String,
  attemptID: Schema.String,
  completion: Hash,
  checks: Schema.Array(Schema.String),
  snapshot: Snapshot,
  directory: Schema.String,
  output: Schema.String,
  target: Schema.Literals(["win32-x64", "win32-arm64", "linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]),
  extension: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+-repair\+[a-f0-9.]+$/)),
  cli: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+-repair\+[a-f0-9.]+$/)),
  at: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "Raya.SelfHealBuildInput" })
export type Build = typeof Build.Type
export const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")

/** This is an input contract, not authority to publish a completion or artifact receipt. */
export async function load(directory: string, file = process.env.RAYA_REPAIR_BUILD_INPUT) {
  if (!file) return undefined
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024 || path.resolve(await fs.realpath(file)) !== path.resolve(file))
    throw new Error("Repair build input is redirected or exceeds its size limit")
  const input = Schema.decodeUnknownSync(Build)(JSON.parse(await fs.readFile(file, "utf8")))
  if (path.resolve(await fs.realpath(directory)) !== path.resolve(input.directory))
    throw new Error("Repair build input belongs to a different checkout")
  if (
    path.dirname(path.resolve(input.output)) !== path.join(path.resolve(input.directory), ".git") ||
    !input.output.endsWith(".vsix")
  )
    throw new Error("Repair artifact output must remain inside its private build metadata directory")
  if (input.target !== `${process.platform}-${process.arch}`)
    throw new Error("Repair artifact builds must target the current host")
  if (input.snapshot.digest !== hash(JSON.stringify({ head: input.snapshot.head, files: input.snapshot.files })))
    throw new Error("Repair build snapshot identity is invalid")
  await unchanged(directory, input.snapshot)
  return input
}

export async function fingerprint(directory: string, paths: string[]) {
  const input = await load(directory)
  if (!input) return undefined
  const files = input.snapshot.files.filter((file) =>
    paths.some(
      (entry) => file.path === entry.replaceAll("\\", "/") || file.path.startsWith(entry.replaceAll("\\", "/") + "/"),
    ),
  )
  return hash(JSON.stringify({ id: input.id, files, cli: input.cli, target: input.target }))
}

export async function digest(file: string) {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || path.resolve(await fs.realpath(file)) !== path.resolve(file))
    throw new Error("Build output is not a private regular file")
  if (stat.size > 1024 * 1024 * 1024) throw new Error("Build output exceeds the 1 GiB inspection limit")
  const hash = createHash("sha256")
  let size = 0
  for await (const chunk of (await import("node:fs")).createReadStream(file)) {
    hash.update(chunk)
    size += chunk.length
  }
  const after = await fs.stat(file)
  if (stat.size !== size || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ino !== after.ino)
    throw new Error("Build output changed while hashing")
  return { digest: hash.digest("hex"), size }
}

export function identity(input: Build) {
  return {
    version: 1 as const,
    id: input.id,
    itemID: input.itemID,
    attemptID: input.attemptID,
    completion: input.completion,
    checks: input.checks,
    source: input.snapshot.digest,
    head: input.snapshot.head,
    target: input.target,
    extension: input.extension,
    cli: input.cli,
    contract: "Captured source input; build checkout is writable and dependencies are not sealed.",
  }
}
