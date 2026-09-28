import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

const worker = path.join(import.meta.dir, "../fixtures/workspace-occupancy-worker.ts")
function launch(input: Record<string, string>) {
  const proc = spawn(process.execPath, [worker, JSON.stringify(input)], {
    cwd: path.join(import.meta.dir, "../../.."),
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  })
  const errors: Buffer[] = []
  proc.stderr.on("data", (data) => errors.push(Buffer.from(data)))
  const done = new Promise<void>((resolve, reject) =>
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(Buffer.concat(errors).toString("utf8") || `Worker exited ${code}`)),
    ),
  )
  return { proc, done }
}
async function wait(file: string) {
  const stop = Date.now() + 30_000
  while (Date.now() < stop) {
    if (
      await fs.stat(file).then(
        () => true,
        () => false,
      )
    )
      return
    await Bun.sleep(20)
  }
  throw new Error(`Timed out waiting for ${file}`)
}
test("full durable registry refuses admission without deleting unknown actors", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "raya-occupancy-cap-"))
  const state = path.join(dir, "state")
  const registry = path.join(state, "workspace-occupancy-v1")
  const workspace = path.join(dir, "workspace")
  await fs.mkdir(registry, { recursive: true })
  await fs.mkdir(workspace)
  try {
    for (let offset = 0; offset < 4096; offset += 64)
      await Promise.all(
        Array.from({ length: 64 }, (_, index) =>
          fs.writeFile(path.join(registry, `${offset + index}.json`), "unknown actor"),
        ),
      )
    const ready = path.join(dir, "ready")
    const first = launch({ state, workspace, ready, release: path.join(dir, "release"), mode: "writer" })
    const error = await first.done.then(
      () => "",
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    )
    expect(error).toContain("Workspace activity limit reached")
    expect(await fs.readdir(registry)).toHaveLength(4096)
    expect(await fs.readFile(path.join(registry, "0.json"), "utf8")).toBe("unknown actor")
    expect(
      await fs.stat(ready).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}, 60_000)
test("separate backend services refuse physical aliases and retain orphan occupancy", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "raya-occupancy-"))
  const procs: ReturnType<typeof launch>[] = []
  try {
    const workspace = path.join(dir, "workspace")
    const nested = path.join(workspace, "nested")
    const alias = path.join(dir, "alias")
    await fs.mkdir(nested, { recursive: true })
    await fs.symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir")
    const common = { state: path.join(dir, "state"), release: path.join(dir, "release") }
    const first = launch({ ...common, workspace: nested, mode: "writer", ready: path.join(dir, "ready") })
    procs.push(first)
    // A killed owner deliberately leaves a durable refusal; heartbeat age is irrelevant.
    void first.done.catch(() => undefined)
    await wait(path.join(dir, "ready"))
    const check = async (name: string, target: string) => {
      const ready = path.join(dir, name)
      const reviewer = launch({ ...common, workspace: target, mode: "review", ready })
      procs.push(reviewer)
      await reviewer.done
      expect(await fs.readFile(ready, "utf8")).toBe("Failure")
    }
    await check("parent", workspace)
    await check("alias-result", alias)
    first.proc.kill()
    await first.done.catch(() => undefined)
    await check("orphan", workspace)
  } finally {
    for (const item of procs) if (item.proc.exitCode === null && item.proc.signalCode === null) item.proc.kill()
    await Promise.allSettled(procs.map((item) => item.done))
    await fs.rm(dir, { recursive: true, force: true })
  }
}, 60_000)
