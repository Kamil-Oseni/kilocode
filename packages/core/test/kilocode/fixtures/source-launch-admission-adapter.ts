import assert from "node:assert/strict"
import { spawn as original } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { read as readiness } from "../../../src/kilocode/source-readiness"

// Observation-only adapter: retain the genuine original child and pipes, not a substitute process.
export const children: {
  child: ReturnType<typeof original>
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  close: Promise<void>
  streams: Promise<void>[]
}[] = []
export const spawn = (...args: Parameters<typeof original>) => {
  const child = original(...args)
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
  const close = new Promise<void>((resolve) => child.once("close", () => resolve()))
  const streams = [child.stdout, child.stderr].map((stream) => {
    assert.ok(stream)
    return new Promise<void>((resolve, reject) => {
      stream.on("data", () => undefined)
      stream.once("end", resolve)
      stream.once("error", reject)
    })
  })
  children.push({ child, exit, close, streams })
  void exit.catch(() => undefined)
  return child
}

let injected = false
let mode = ""
export function configure(value: string) {
  assert.ok(value === "malformed" || value === "identity" || value === "ended")
  mode = value
}
export function changed() {
  return injected
}
export const read: typeof readiness = async (file, helper, probe) => {
  const value = await readiness(file, helper, probe)
  if (!file.endsWith(".source-launch") || value === undefined || injected) return value
  assert.equal(children.length, 1)
  assert.ok(typeof value === "object" && value !== null && "helper" in value)
  assert.equal(value.helper, children[0].child.pid)
  injected = true
  if (mode === "ended") {
    const owner = children[0]
    await Promise.all([owner.exit, owner.close, ...owner.streams])
    assert.equal(owner.child.stdout?.readableEnded, true)
    assert.equal(owner.child.stderr?.readableEnded, true)
  }
  // Real filesystem failure at the read boundary; production held reader performs the second read.
  await writeFile(file, mode !== "identity" ? "{" : JSON.stringify({ ...value, digest: "0".repeat(64) }))
  return readiness(file, helper, probe)
}
