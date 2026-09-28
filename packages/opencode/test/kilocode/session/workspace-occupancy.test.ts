import { expect, test } from "bun:test"
import { Schema } from "effect"
import { WorkspaceOccupancy } from "@/kilocode/session/workspace-occupancy"
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

test("exact durable reservation retires across backends and resumes from a release receipt without deleting another actor", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "raya-occupancy-recovery-"))
  const workspace = path.join(dir, "workspace")
  const state = path.join(dir, "state")
  const identity = path.join(dir, "identity.json")
  await fs.mkdir(workspace)
  const controllers: ReturnType<typeof launch>[] = []
  try {
    await launch({ state, workspace, ready: identity, release: identity, mode: "reserve" }).done
    const actor = Schema.decodeUnknownSync(WorkspaceOccupancy.Reservation)(
      JSON.parse(await fs.readFile(identity, "utf8")),
    )
    const file = path.join(state, "workspace-occupancy-v1", `${actor.token}.json`)
    const receipt = path.join(state, "workspace-occupancy-released-v1", `${actor.token}.json`)
    const ready = path.join(dir, "controller.ready")
    const command = path.join(dir, "controller.command")
    const control = launch({ state, workspace, ready, release: command, mode: "control" })
    controllers.push(control)
    await wait(ready)
    const request = async (operation: string, name: string) => {
      await fs.writeFile(
        command + ".tmp",
        JSON.stringify({ id: name, operation, identity: JSON.parse(await fs.readFile(identity, "utf8")) }),
      )
      await fs.rename(command + ".tmp", command)
      const deadline = performance.now() + 15000
      while (performance.now() < deadline) {
        const result: unknown = JSON.parse(await fs.readFile(ready, "utf8"))
        if (
          result &&
          typeof result === "object" &&
          "id" in result &&
          result.id === name &&
          "ok" in result &&
          "message" in result
        )
          return { ok: result.ok, message: String(result.message) }
        await Bun.sleep(20)
      }
      throw new Error("Controller response exceeded deadline")
    }
    expect((await request("review", "busy")).ok).toBe(false)
    // Real filesystem crash boundary: receipt publication completed, original actor still occupied.
    await fs.mkdir(path.dirname(receipt))
    await fs.link(file, receipt)
    const content = await fs.readFile(identity, "utf8")
    await fs.writeFile(file, content.replace("process-worker", "linked-foreign-worker"))
    expect(await fs.readFile(receipt, "utf8")).toContain("linked-foreign-worker")
    expect((await request("retire", "linked")).message).toContain("ownership changed")
    await fs.writeFile(file, content)
    await fs.writeFile(identity, content.replace("process-worker", "foreign-worker"))
    expect((await request("retire", "foreign")).message).toContain("ownership changed")
    expect(await fs.readFile(file, "utf8")).toBe(content)
    await fs.writeFile(identity, content)
    expect((await request("retire", "first")).ok).toBe(true)
    expect(await Bun.file(file).exists()).toBe(false)
    expect(await fs.readFile(receipt, "utf8")).toBe(content)
    expect((await request("retire", "retry")).ok).toBe(true)
    const second = path.join(dir, "second.json")
    await launch({ state, workspace, ready: second, release: second, mode: "reserve" }).done
    expect((await request("review", "other")).ok).toBe(false)
    expect((await request("forget", "forgot")).ok).toBe(true)
    expect(await Bun.file(receipt).exists()).toBe(false)
    expect((await request("retire", "missing")).message).toContain("no confirmed release receipt")
    const remaining = Schema.decodeUnknownSync(WorkspaceOccupancy.Reservation)(
      JSON.parse(await fs.readFile(second, "utf8")),
    )
    expect(await Bun.file(path.join(state, "workspace-occupancy-v1", `${remaining.token}.json`)).exists()).toBe(true)
    await fs.writeFile(command, JSON.stringify({ id: "done", operation: "done" }))
    await control.done
  } finally {
    for (const actor of controllers)
      if (actor.proc.exitCode === null && actor.proc.signalCode === null) actor.proc.kill()
    await Promise.allSettled(controllers.map((actor) => actor.done))
    await fs.rm(dir, { recursive: true, force: true })
  }
}, 180000)
