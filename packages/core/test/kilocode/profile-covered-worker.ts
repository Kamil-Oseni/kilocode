import { mkdir, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import os from "node:os"
import path from "node:path"
import {
  acquireCoveredProfileRoot,
  acquireProfileRoot,
  admitProfileOperation,
  resolveProfileRoot,
} from "../../src/kilocode/profile-maintenance"
import { publish } from "../../src/kilocode/profile-record"
import { Hash } from "../../src/util/hash"

const parsed: unknown = JSON.parse(process.argv[2])
if (
  !parsed ||
  typeof parsed !== "object" ||
  !("root" in parsed) ||
  typeof parsed.root !== "string" ||
  !("dir" in parsed) ||
  typeof parsed.dir !== "string"
)
  throw new Error("Invalid private worker input")
const input = { root: parsed.root, dir: parsed.dir }
const root = { kind: "json" as const, path: input.root }
const resolved = await resolveProfileRoot(root)
const dir = path.join(path.dirname(resolved.path), ".raya-profile-locks", Hash.fast(resolved.id) + ".writers")
async function wait(name: string) {
  const stop = performance.now() + 5_000
  while (!(await Bun.file(path.join(input.dir, name)).exists())) {
    if (performance.now() > stop) throw new Error("Subprocess coordination deadline elapsed")
    await Bun.sleep(5)
  }
}
if ("mode" in parsed && parsed.mode === "covered") {
  const outer = await acquireProfileRoot({ kind: "json", path: path.dirname(root.path) })
  const child = await acquireCoveredProfileRoot(root, outer)
  await writeFile(path.join(input.dir, "ready"), "genuine covered admission")
  await wait("child-release")
  await child.release()
  await writeFile(path.join(input.dir, "released"), "defensive reference retained")
  await wait("parent-release")
  await outer.release()
  await writeFile(path.join(input.dir, "done"), "genuine parent cleanup settled")
  process.exit(0)
}
await mkdir(dir, { recursive: true })
await writeFile(path.join(input.dir, "ready"), "mkdir completed")
await wait("publish")
const token = randomUUID()
const file = path.join(dir, token + ".json")
const failure = (() => {
  try {
    publish(file, JSON.stringify({ pid: process.pid, hostname: os.hostname(), token }))
    throw new Error("Expected the actual removed-directory publication to fail")
  } catch (err) {
    if (!(err instanceof AggregateError) || err.errors.length !== 1) throw err
    const cause: unknown = err.errors[0]
    if (!cause || typeof cause !== "object" || !("code" in cause) || cause.code !== "ENOENT") throw err
    return cause
  }
})()
await writeFile(path.join(input.dir, "failure.json"), JSON.stringify(failure))
const admitted = admitProfileOperation(root)
await writeFile(path.join(input.dir, "admitted"), "real default admission after directory recreation")
await wait("release")
admitted.release()
await writeFile(path.join(input.dir, "done"), "released")
