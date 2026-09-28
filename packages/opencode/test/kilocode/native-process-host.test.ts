import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { NativeProcess } from "@opencode-ai/core/kilocode/process-host/index"
import { sample } from "@/kilocode/background-process/windows-tree"
import { guardian } from "@/kilocode/background-process/windows-job"
import { BackgroundProcessRunner } from "@/kilocode/background-process/runner"

const live = test.skipIf(process.platform !== "win32")

async function wait(file: string) {
  const deadline = performance.now() + 10000
  while (performance.now() < deadline) {
    if (await Bun.file(file).exists()) return
    await Bun.sleep(10)
  }
  throw new Error("Native fixture readiness exceeded deadline")
}

live(
  "native guardian refuses a mismatched birth and handles stop before command admission",
  async () => {
    expect(NativeProcess.mode()).toBe("native")
    await NativeProcess.check()
    expect(await NativeProcess.protocol()).toEqual({ version: 1, proof: "windows-job", architecture: "x64" })
    const dir = await mkdtemp(path.join(os.tmpdir(), "raya-native-"))
    const control = path.join(dir, "control")
    const token = randomUUID()
    const root = path.join(dir, "root.ts")
    await writeFile(
      root,
      `while (!await Bun.file(${JSON.stringify(control + ".go")}).exists()) await Bun.sleep(10); await Bun.write(${JSON.stringify(path.join(dir, "effect"))}, "opened")`,
    )
    const child = spawn(process.execPath, [root], { stdio: "ignore", windowsHide: true })
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    const owners = await Promise.all([sample(child.pid!), sample(process.pid)])
    if (!owners[0].birth || !owners[1].birth) throw new Error("Native fixture identity unavailable")
    const input = {
      pid: child.pid!,
      birth: owners[0].birth,
      controller: process.pid,
      parentBirth: owners[1].birth,
      control,
      token,
    }
    try {
      const rejected = await guardian({ ...input, birth: (BigInt(input.birth) + 1n).toString() })
      rejected.stderr?.resume()
      const refused = await new Promise<number>((resolve, reject) => {
        rejected.once("error", reject)
        rejected.once("exit", (code) => resolve(code ?? 1))
      })
      expect(refused).not.toBe(0)
      expect(await Bun.file(control + ".job").exists()).toBe(false)
      expect((await sample(child.pid!)).status).toBe("owned")
      await writeFile(control, "stop")
      const guard = await guardian(input)
      guard.stderr?.resume()
      const closed = new Promise<number>((resolve, reject) => {
        guard.once("error", reject)
        guard.once("exit", (code) => resolve(code ?? 1))
      })
      expect(await closed).toBe(0)
      await exited
      expect(await BackgroundProcessRunner.drained(control, token)).toBe(true)
      expect(await Bun.file(control + ".go").exists()).toBe(false)
      expect(await Bun.file(path.join(dir, "effect")).exists()).toBe(false)
    } finally {
      child.kill()
      await exited
      await rm(dir, { recursive: true, force: true })
    }
  },
  30000,
)

live(
  "measures fresh native inspect and assignment without runtime compilation",
  async () => {
    const samples: number[] = []
    for (const _ of Array.from({ length: 21 })) {
      const start = performance.now()
      expect((await sample(process.pid)).status).toBe("owned")
      samples.push(performance.now() - start)
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), "raya-native-time-"))
    const timings: number[] = []
    try {
      for (const _ of Array.from({ length: 6 })) {
        const control = path.join(dir, randomUUID())
        const token = randomUUID()
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          stdio: "ignore",
          windowsHide: true,
        })
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
        const owners = await Promise.all([sample(child.pid!), sample(process.pid)])
        if (!owners[0].birth || !owners[1].birth) throw new Error("Native fixture identity unavailable")
        const start = performance.now()
        const guard = await guardian({
          pid: child.pid!,
          birth: owners[0].birth,
          controller: process.pid,
          parentBirth: owners[1].birth,
          control,
          token,
        })
        guard.stderr?.resume()
        const closed = new Promise<number>((resolve, reject) => {
          guard.once("error", reject)
          guard.once("exit", (code) => resolve(code ?? 1))
        })
        try {
          await wait(control + ".job")
          timings.push(performance.now() - start)
          expect(JSON.parse(await readFile(control + ".job", "utf8")).token).toBe(token)
          await writeFile(control, "stop")
          expect(await closed).toBe(0)
          expect(await BackgroundProcessRunner.drained(control, token)).toBe(true)
        } finally {
          guard.kill()
          child.kill()
          await exited
        }
      }
      const inspect = samples.slice(1).sort((a, b) => a - b)
      const assignment = timings.slice(1).sort((a, b) => a - b)
      console.log(
        JSON.stringify({
          native: 1,
          machine: `${process.platform}-${process.arch}`,
          inspect: { first: samples[0], count: inspect.length, p50: inspect[9], p95: inspect[18] },
          assignment: { first: timings[0], count: assignment.length, p50: assignment[2], p95: assignment[4] },
          units: "milliseconds",
          cold: "first invocation, OS cache not flushed",
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
  60000,
)
