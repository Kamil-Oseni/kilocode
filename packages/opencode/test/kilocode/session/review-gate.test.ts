import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const worker = path.join(import.meta.dir, "../fixtures/review-gate-worker.ts")

async function exists(file: string) {
  return fs.stat(file).then(
    () => true,
    () => false,
  )
}

async function wait(file: string) {
  const stop = Date.now() + 30_000
  while (Date.now() < stop) {
    if (await exists(file)) return
    await Bun.sleep(20)
  }
  throw new Error(`Timed out waiting for ${file}`)
}

function run(input: Record<string, string | number | string[]>) {
  return spawn(process.execPath, [worker, JSON.stringify(input)], {
    cwd: path.join(import.meta.dir, "../../.."),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
}

function closed(proc: ReturnType<typeof run>) {
  return new Promise<{ code: number | null; error: string }>((resolve) => {
    const errors: Buffer[] = []
    const timeout = setTimeout(() => proc.kill(), 45_000)
    proc.stderr.on("data", (data) => errors.push(Buffer.from(data)))
    proc.on("close", (code) => {
      clearTimeout(timeout)
      resolve({ code, error: Buffer.concat(errors).toString("utf8") })
    })
  })
}

describe("review gate", () => {
  for (const failure of ["failure", "interruption"]) {
    test(`releases every acquired workspace after body ${failure}`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "raya-review-gate-"))
      const proc = run({
        workspace: path.join(root, "a"),
        workspaces: [path.join(root, "b"), path.join(root, "a")],
        failure,
        state: path.join(root, "state"),
        active: path.join(root, "active"),
        ready: path.join(root, "ready"),
        done: path.join(root, "done"),
        hold: 0,
      })
      try {
        expect(await closed(proc)).toEqual({ code: 0, error: "" })
        expect(await exists(path.join(root, "done"))).toBe(true)
        expect(await exists(path.join(root, "active"))).toBe(false)
      } finally {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill()
        await fs.rm(root, { recursive: true, force: true })
      }
    }, 60_000)
  }
  test("opposite ordered workspace sets and duplicate aliases serialize across processes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "raya-review-gate-"))
    const procs: ReturnType<typeof run>[] = []
    try {
      const a = path.join(root, "a")
      const b = path.join(root, "b")
      const alias = process.platform === "win32" ? a.toUpperCase() : path.join(a, ".")
      const common = {
        workspace: a,
        state: path.join(root, "state"),
        active: path.join(root, "active"),
        go: path.join(root, "go"),
        hold: 100,
      }
      const first = {
        ...common,
        workspaces: [a, b, alias],
        started: path.join(root, "first-started"),
        ready: path.join(root, "first-ready"),
        done: path.join(root, "first-done"),
      }
      const second = {
        ...common,
        workspaces: [b, a],
        started: path.join(root, "second-started"),
        ready: path.join(root, "second-ready"),
        done: path.join(root, "second-done"),
      }
      const one = run(first)
      procs.push(one)
      const two = run(second)
      procs.push(two)
      const results = Promise.all([closed(one), closed(two)])
      await Promise.all([wait(first.started), wait(second.started)])
      expect(one.pid).not.toBe(two.pid)
      await fs.writeFile(common.go, "go")
      expect(await results).toEqual([
        { code: 0, error: "" },
        { code: 0, error: "" },
      ])
      expect(await exists(first.done)).toBe(true)
      expect(await exists(second.done)).toBe(true)
      expect(await exists(common.active)).toBe(false)
    } finally {
      for (const proc of procs) if (proc.exitCode === null && proc.signalCode === null) proc.kill()
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  test("a multiple-workspace transaction blocks compatible single-workspace callers on every member", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "raya-review-gate-"))
    const procs: ReturnType<typeof run>[] = []
    try {
      const a = path.join(root, "a")
      const b = path.join(root, "b")
      const common = { state: path.join(root, "state"), active: path.join(root, "active"), hold: 0 }
      const first = {
        ...common,
        workspace: a,
        workspaces: [a, b],
        release: path.join(root, "release"),
        ready: path.join(root, "first-ready"),
        done: path.join(root, "first-done"),
      }
      const second = {
        ...common,
        workspace: b,
        started: path.join(root, "second-started"),
        ready: path.join(root, "second-ready"),
        done: path.join(root, "second-done"),
      }
      const one = run(first)
      procs.push(one)
      const firstResult = closed(one)
      await wait(first.ready)
      const two = run(second)
      procs.push(two)
      const secondResult = closed(two)
      await wait(second.started)
      await Bun.sleep(150)
      expect(await exists(second.ready)).toBe(false)
      await fs.writeFile(first.release, "release")
      expect(await Promise.all([firstResult, secondResult])).toEqual([
        { code: 0, error: "" },
        { code: 0, error: "" },
      ])
      expect(await exists(second.done)).toBe(true)
    } finally {
      for (const proc of procs) if (proc.exitCode === null && proc.signalCode === null) proc.kill()
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  test("disjoint workspace sets preserve the single process lifecycle semaphore", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "raya-review-gate-"))
    const proc = run({
      workspace: path.join(root, "a"),
      workspaces: [path.join(root, "a")],
      sibling: path.join(root, "b"),
      state: path.join(root, "state"),
      active: path.join(root, "active"),
      ready: path.join(root, "ready"),
      done: path.join(root, "done"),
      hold: 100,
    })
    try {
      expect(await closed(proc)).toEqual({ code: 0, error: "" })
      expect(await exists(path.join(root, "done"))).toBe(true)
      expect(await exists(path.join(root, "active"))).toBe(false)
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill()
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  test("serializes the same workspace across backend processes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "raya-review-gate-"))
    const procs: ReturnType<typeof run>[] = []
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
        hold: 0,
        release: path.join(root, "release"),
      }
      const alias = process.platform === "win32" ? workspace.toUpperCase() : path.join(workspace, ".")
      const second = {
        workspace: alias,
        state,
        active,
        ready: path.join(root, "second-ready"),
        done: path.join(root, "second-done"),
        hold: 0,
        started: path.join(root, "second-started"),
      }
      await fs.mkdir(workspace)

      const a = run(first)
      procs.push(a)
      const aclose = closed(a)
      await wait(first.ready)
      const b = run(second)
      procs.push(b)
      const bclose = closed(b)
      await wait(second.started)
      await Bun.sleep(150)
      expect(await exists(second.ready)).toBe(false)
      await fs.writeFile(first.release, "release")

      const [ares, bres] = await Promise.all([aclose, bclose])
      expect(ares).toEqual({ code: 0, error: "" })
      expect(bres).toEqual({ code: 0, error: "" })
      expect(await exists(first.done)).toBe(true)
      expect(await exists(second.done)).toBe(true)
    } finally {
      for (const proc of procs) if (proc.exitCode === null && proc.signalCode === null) proc.kill()
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
