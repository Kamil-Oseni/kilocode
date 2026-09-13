import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const worker = path.join(import.meta.dir, "../fixtures/review-gate-worker.ts")

async function exists(file: string) {
  return fs.stat(file).then(() => true, () => false)
}

async function wait(file: string) {
  const stop = Date.now() + 5_000
  while (Date.now() < stop) {
    if (await exists(file)) return
    await Bun.sleep(20)
  }
  throw new Error(`Timed out waiting for ${file}`)
}

function run(input: Record<string, string | number>) {
  return spawn(process.execPath, [worker, JSON.stringify(input)], {
    cwd: path.join(import.meta.dir, "../../.."),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
}

function closed(proc: ReturnType<typeof run>) {
  return new Promise<{ code: number | null; error: string }>((resolve) => {
    const errors: Buffer[] = []
    proc.stderr.on("data", (data) => errors.push(Buffer.from(data)))
    proc.on("close", (code) => resolve({ code, error: Buffer.concat(errors).toString("utf8") }))
  })
}

describe("review gate", () => {
  test("serializes the same workspace across backend processes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "raya-review-gate-"))
    try {
      const workspace = path.join(root, "workspace")
      const state = path.join(root, "state")
      const active = path.join(root, "active")
      const first = {
        workspace,
        state,
        active,
        ready: path.join(root, "first-ready"),
        done: path.join(root, "first-done"),
        hold: 500,
      }
      const alias = process.platform === "win32" ? workspace.toUpperCase() : path.join(workspace, ".")
      const second = {
        workspace: alias,
        state,
        active,
        ready: path.join(root, "second-ready"),
        done: path.join(root, "second-done"),
        hold: 0,
      }
      await fs.mkdir(workspace)

      const a = run(first)
      const aclose = closed(a)
      await wait(first.ready)
      const b = run(second)
      const bclose = closed(b)
      await Bun.sleep(150)
      expect(await exists(second.ready)).toBe(false)

      const [ares, bres] = await Promise.all([aclose, bclose])
      expect(ares).toEqual({ code: 0, error: "" })
      expect(bres).toEqual({ code: 0, error: "" })
      expect(await exists(first.done)).toBe(true)
      expect(await exists(second.done)).toBe(true)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 15_000)
})
