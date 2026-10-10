import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { acceptance } from "../../src/second-brain/control/acceptance"
import { command } from "../../src/second-brain/control/command"

test("cancelled helper acceptance retains the actual original natural join and prevents the next spawn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-helper-acceptance-"))
  const ready = path.join(root, "ready")
  const release = path.join(root, "release")
  const next = path.join(root, "next")
  const controller = new AbortController()
  const state = { settled: false }
  const script = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(release)}))return;clearInterval(timer);process.stdout.write('joined-original');process.stderr.write('private-original-stderr');},10)`
  const work = acceptance(
    () => controller.signal.throwIfAborted(),
    async () => {
      await command(process.execPath, ["-e", script], { cwd: root })
      await command(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(next)},'replayed')`], {
        cwd: root,
      })
    },
  )
  const result = work.then(
    () => {
      state.settled = true
      return undefined
    },
    (err: unknown) => {
      state.settled = true
      return err
    },
  )
  try {
    const deadline = performance.now() + 5000
    while (!(await Bun.file(ready).exists())) {
      if (performance.now() >= deadline) throw new Error("Original helper did not publish readiness")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const pid = Number(await readFile(ready, "utf8"))
    expect(pid).toBeGreaterThan(0)
    controller.abort(new Error("Parent acceptance cancelled"))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(state.settled).toBe(false)
    expect(await Bun.file(next).exists()).toBe(false)
    await writeFile(release, "original may finish")
    const error = await result
    expect(error).toBeInstanceOf(AggregateError)
    const retained = error as AggregateError & {
      receipt: {
        pid: number
        code: number
        stdoutEOF: boolean
        stderrEOF: boolean
        originalJoined: boolean
        readersJoined: boolean
        forced: boolean
        observationExpired: boolean
      }
      output: { stdout: string; stderr: string }
    }
    expect(retained.receipt).toMatchObject({
      pid,
      code: 0,
      stdoutEOF: true,
      stderrEOF: true,
      originalJoined: true,
      readersJoined: true,
      forced: false,
      observationExpired: false,
    })
    expect(retained.output).toMatchObject({ stdout: "joined-original", stderr: "private-original-stderr" })
    expect(retained.message).not.toContain("private-original-stderr")
    expect(JSON.stringify(retained)).not.toContain("private-original-stderr")
    expect(await Bun.file(next).exists()).toBe(false)
  } finally {
    await writeFile(release, "original may finish")
    await result
    await rm(root, { recursive: true, force: true })
  }
}, 15000)

test("a leaked callback retains its retired acceptance scope and cannot spawn under a newer owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-helper-retired-"))
  const marker = path.join(root, "spawned")
  const pending = Promise.withResolvers<unknown>()
  try {
    await acceptance(
      () => {},
      async () => {
        setTimeout(() => {
          command(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'effect')`], {
            cwd: root,
          }).then(pending.resolve, pending.resolve)
        }, 20)
      },
    )
    await acceptance(
      () => {},
      async () => {
        expect(await pending.promise).toBeInstanceOf(Error)
        expect(await Bun.file(marker).exists()).toBe(false)
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
