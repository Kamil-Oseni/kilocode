import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { spawn as child } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { NativeProcess } from "@opencode-ai/core/kilocode/process-host/index"
import { spawn } from "@opencode-ai/core/pty/driver"
import { BackgroundProcessRunner } from "@/kilocode/background-process/runner"
import { sample } from "@/kilocode/background-process/windows-tree"

const live = test.skipIf(process.platform !== "win32")

async function wait(file: string) {
  const deadline = performance.now() + 15000
  while (performance.now() < deadline) {
    if (await Bun.file(file).exists()) return
    await Bun.sleep(20)
  }
  throw new Error("Native PTY fixture readiness exceeded bound")
}

async function fixture(
  source: string,
  args: string[] = [],
  before?: (control: string) => Promise<void>,
  cfg: { timeout?: number; controller?: number; birth?: string } = {},
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-native-pty-"))
  const control = path.join(dir, "control")
  const token = randomUUID()
  const script = path.join(dir, "target.ts")
  const owner = await sample(process.pid)
  if (!owner.birth) throw new Error("Native fixture controller identity missing")
  await writeFile(script, source)
  const input = {
    command: process.execPath,
    args: [script, ...args],
    cwd: dir,
    env: { ...process.env, TEST_NATIVE_PTY: "héllo 🌿" } as Record<string, string>,
    controller: process.pid,
    birth: owner.birth,
    control,
    token,
    ...cfg,
  }
  const spec = await NativeProcess.prepare(input)
  await before?.(control)
  const proc = spawn(spec.command, spec.args, {
    name: "xterm-256color",
    cwd: spec.cwd,
    env: spec.env,
    cols: 90,
    rows: 30,
  })
  let output = ""
  const data = proc.onData((chunk) => {
    if (output.length < 65536) output += chunk
  })
  const closed = new Promise<number>((resolve) => proc.onExit((value) => resolve(value.exitCode)))
  return {
    dir,
    control,
    token,
    input,
    spec,
    proc,
    closed,
    output: () => output,
    cleanup: async () => {
      await writeFile(control, "stop")
      await closed
      data.dispose()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

for (const mode of ["helper", "target", "job"] as const)
  live(
    `refuses a replaced ${mode} identity before writing native admission`,
    async () => {
      const actor = await fixture(`await Bun.write("effect", "executed")`)
      try {
        await wait(actor.control + ".launch")
        const identity = await NativeProcess.suspended(actor.control, actor.token)
        const file = actor.control + (mode === "job" ? ".job" : ".launch")
        const record = JSON.parse(await readFile(file, "utf8"))
        if (mode === "helper") record.helperBirth = (BigInt(identity.helperBirth) + 1n).toString()
        if (mode === "target") record.pid = process.pid
        if (mode === "job") record.token = randomUUID()
        await writeFile(file, JSON.stringify(record))
        const refused = await NativeProcess.resume(actor.control, actor.token, identity).then(
          () => undefined,
          (err: unknown) => err,
        )
        expect(refused).toBeInstanceOf(Error)
        expect(await Bun.file(actor.control + ".go").exists()).toBe(false)
        expect(await Bun.file(path.join(actor.dir, "effect")).exists()).toBe(false)
      } finally {
        await actor.cleanup()
      }
    },
    30000,
  )

for (const phase of ["admission", "publication"] as const)
  live(
    `drains assigned native targets after ${phase} failure without inventing success or replay`,
    async () => {
      const actor = await fixture(`await Bun.write("effect", "executed"); setInterval(() => {}, 1000)`)
      try {
        await wait(actor.control + ".launch")
        const identity = await NativeProcess.suspended(actor.control, actor.token)
        if (phase === "admission") await writeFile(actor.control + ".go", "invalid admission")
        if (phase === "publication") {
          await mkdir(actor.control + ".running.tmp")
          await NativeProcess.resume(actor.control, actor.token, identity)
        }
        expect(await actor.closed).not.toBe(0)
        expect(await BackgroundProcessRunner.drained(actor.control, actor.token)).toBe(true)
        expect(JSON.parse(await readFile(actor.control + ".exited", "utf8"))).toEqual({
          version: 1,
          token: actor.token,
          proof: "windows-job",
          pid: identity.pid,
          birth: identity.birth,
          state: "exited",
          outcome: "unknown",
        })
        expect((await sample(identity.pid)).status).toBe("gone")
        if (phase === "admission") expect(await Bun.file(path.join(actor.dir, "effect")).exists()).toBe(false)
        expect(actor.output()).toContain(
          phase === "admission" ? "Native admission identity changed" : "Native receipt write failed",
        )
        await expect(NativeProcess.resume(actor.control, actor.token, identity)).rejects.toThrow()
        expect(JSON.parse(await readFile(actor.control + ".exited", "utf8"))).toHaveProperty("outcome", "unknown")
      } finally {
        await actor.cleanup()
      }
    },
    30000,
  )

for (const mode of ["timeout", "controller", "helper"] as const)
  live(
    `never resumes a suspended target after ${mode} loss`,
    async () => {
      const controller =
        mode === "controller"
          ? child(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true })
          : undefined
      const owner = controller?.pid ? await sample(controller.pid) : undefined
      if (controller && !owner?.birth) throw new Error("Native test controller identity missing")
      const cfg =
        controller && owner?.birth
          ? { controller: controller.pid!, birth: owner.birth }
          : { timeout: mode === "timeout" ? 150 : 60000 }
      const actor = await fixture(`await Bun.write("effect", "executed")`, [], undefined, cfg)
      try {
        await wait(actor.control + ".launch")
        const identity = await NativeProcess.suspended(actor.control, actor.token)
        if (mode === "controller") controller?.kill()
        if (mode === "helper") actor.proc.kill()
        await actor.closed
        expect(await Bun.file(path.join(actor.dir, "effect")).exists()).toBe(false)
        expect((await sample(identity.pid)).status).toBe("gone")
        expect(
          mode === "helper"
            ? !(await Bun.file(actor.control + ".drained").exists())
            : await BackgroundProcessRunner.drained(actor.control, actor.token),
        ).toBe(true)
        const refused = await NativeProcess.resume(actor.control, actor.token, identity).then(
          () => undefined,
          (err: unknown) => err,
        )
        expect(refused).toBeInstanceOf(Error)
        expect(await Bun.file(actor.control + ".go").exists()).toBe(false)
      } finally {
        controller?.kill()
        await actor.cleanup()
      }
    },
    30000,
  )

live(
  "contains a real executable before admission and preserves exact Unicode argv, cwd, env, and PTY input",
  async () => {
    const args = ["", "space value", 'quote"value', "trail\\", 'before\\"quote', "雪🌿é"]
    const source = `process.stdin.setEncoding("utf8")
process.stdin.once("data", async (data) => { await Bun.write("input.json", JSON.stringify(data.trim())); console.log("INPUT:" + data.trim()); process.exit(0) })
await Bun.write("meta.tmp", JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),env:process.env.TEST_NATIVE_PTY,private:process.env.RAYA_PTY_LAUNCH ?? null}))
await (await import("node:fs/promises")).rename("meta.tmp", "meta.json")
console.log("READY")`
    const actor = await fixture(source, args)
    try {
      await wait(actor.control + ".launch")
      const identity = await NativeProcess.suspended(actor.control, actor.token)
      expect((await sample(identity.pid)).birth).toBe(identity.birth)
      expect(await BackgroundProcessRunner.contained(actor.control, actor.token)).toBe(true)
      await Bun.sleep(100)
      expect(await Bun.file(path.join(actor.dir, "meta.json")).exists()).toBe(false)
      await NativeProcess.resume(actor.control, actor.token, identity)
      await wait(path.join(actor.dir, "meta.json"))
      expect(JSON.parse(await readFile(path.join(actor.dir, "meta.json"), "utf8"))).toEqual({
        args,
        cwd: actor.dir,
        env: "héllo 🌿",
        private: null,
      })
      const duplicate = await NativeProcess.resume(actor.control, actor.token, identity).then(
        () => undefined,
        (err: unknown) => err,
      )
      expect(duplicate).toBeInstanceOf(Error)
      actor.proc.resize(100, 35)
      actor.proc.write("hëllo 🌿\r")
      await actor.closed
      expect(JSON.parse(await readFile(path.join(actor.dir, "input.json"), "utf8"))).toBe("hëllo 🌿")
      expect(actor.output()).toContain("READY")
      expect(actor.output()).toContain("INPUT:hëllo 🌿")
      expect(await BackgroundProcessRunner.drained(actor.control, actor.token)).toBe(true)
    } finally {
      await actor.cleanup()
    }
  },
  45000,
)

for (const mode of ["stop", "initialstop", "stale", "substitution"] as const)
  live(
    `refuses native PTY execution for ${mode} admission`,
    async () => {
      const actor = await fixture(
        `await Bun.write("effect", "executed")`,
        [],
        mode === "stale"
          ? (control) => writeFile(control + ".go", "old admission")
          : mode === "initialstop"
            ? (control) => writeFile(control, "stop")
            : undefined,
      )
      try {
        if (mode !== "stale") {
          await wait(actor.control + ".launch")
          const identity = await NativeProcess.suspended(actor.control, actor.token)
          if (mode === "stop") await writeFile(actor.control, "stop")
          if (mode === "substitution")
            await writeFile(
              actor.control + ".go",
              JSON.stringify({
                version: 1,
                token: randomUUID(),
                pid: identity.pid,
                birth: identity.birth,
                action: "resume",
              }),
            )
        }
        const code = await actor.closed
        expect(mode === "stop" || mode === "initialstop" ? code === 0 : code !== 0).toBe(true)
        expect(await Bun.file(path.join(actor.dir, "effect")).exists()).toBe(false)
        if (mode === "stop" || mode === "initialstop")
          expect(await BackgroundProcessRunner.drained(actor.control, actor.token)).toBe(true)
        if (mode === "stale") expect(await Bun.file(actor.control + ".launch").exists()).toBe(false)
        if (mode === "substitution") {
          expect(await BackgroundProcessRunner.drained(actor.control, actor.token)).toBe(true)
          expect(JSON.parse(await readFile(actor.control + ".exited", "utf8"))).toHaveProperty("outcome", "unknown")
        }
      } finally {
        await actor.cleanup()
      }
    },
    30000,
  )

live(
  "keeps a detached grandchild contained after the launched target exits",
  async () => {
    const actor = await fixture(
      `import {spawn} from "node:child_process"; const child = spawn(process.execPath, ["middle.ts"], {stdio:"ignore"}); await new Promise(resolve=>child.once("exit",resolve))`,
      [],
      async (control) => {
        const dir = path.dirname(control)
        await writeFile(
          path.join(dir, "middle.ts"),
          `import {spawn} from "node:child_process"; spawn(process.execPath,["leaf.ts"],{detached:true,stdio:"ignore"}).unref()`,
        )
        await writeFile(
          path.join(dir, "leaf.ts"),
          `await Bun.write("leaf",String(process.pid)); await Bun.sleep(60000)`,
        )
      },
    )
    try {
      await wait(actor.control + ".launch")
      const identity = await NativeProcess.suspended(actor.control, actor.token)
      await NativeProcess.resume(actor.control, actor.token, identity)
      await wait(path.join(actor.dir, "leaf"))
      const leaf = Number(await readFile(path.join(actor.dir, "leaf"), "utf8"))
      const deadline = performance.now() + 10000
      while ((await sample(identity.pid)).status === "owned" && performance.now() < deadline) await Bun.sleep(20)
      expect((await sample(identity.pid)).status).toBe("gone")
      expect((await sample(leaf)).status).toBe("owned")
      expect(await Bun.file(actor.control + ".drained").exists()).toBe(false)
      await writeFile(actor.control, "stop")
      await actor.closed
      expect((await sample(leaf)).status).toBe("gone")
      expect(await BackgroundProcessRunner.drained(actor.control, actor.token)).toBe(true)
    } finally {
      await actor.cleanup()
    }
  },
  45000,
)
