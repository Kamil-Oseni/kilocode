import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { guardian } from "@/kilocode/background-process/windows-job"
import { sample } from "@/kilocode/background-process/windows-tree"
import { BackgroundProcessRunner } from "@/kilocode/background-process/runner"

async function wait(file: string) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    if (await Bun.file(file).exists()) return
    await Bun.sleep(50)
  }
  throw new Error("Native fixture did not become ready")
}

for (const mode of ["stop", "guardian", "controller"] as const)
  test.skipIf(process.platform !== "win32")(
    `contains a detached grandchild after its intermediary exits (${mode})`,
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "raya-job-"))
      const control = path.join(dir, "control")
      const token = randomUUID()
      const leaf = path.join(dir, "leaf.ts")
      const middle = path.join(dir, "middle.ts")
      const root = path.join(dir, "root.ts")
      await mkdir(dir, { recursive: true })
      await writeFile(
        leaf,
        `await Bun.write(${JSON.stringify(path.join(dir, "leaf-ready"))}, String(process.pid)); await Bun.sleep(60000); await Bun.write(${JSON.stringify(path.join(dir, "late"))}, "late")`,
      )
      await writeFile(
        middle,
        `import {spawn} from "node:child_process"; spawn(process.execPath, [${JSON.stringify(leaf)}], {detached:true,stdio:"ignore"}).unref()`,
      )
      await writeFile(
        root,
        `while (!await Bun.file(${JSON.stringify(control + ".go")}).exists()) await Bun.sleep(50); const child = Bun.spawn([process.execPath, ${JSON.stringify(middle)}], {stdout:"ignore",stderr:"ignore"}); await child.exited`,
      )
      const child = spawn(process.execPath, [root], { stdio: "ignore", windowsHide: true })
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
      const controller =
        mode === "controller"
          ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true })
          : undefined
      const owner = controller?.pid ?? process.pid
      const owners = await Promise.all([sample(child.pid!), sample(owner)])
      if (!owners[0].birth || !owners[1].birth) throw new Error("Missing native fixture identity")
      const guard = guardian({
        pid: child.pid!,
        birth: owners[0].birth,
        controller: owner,
        parentBirth: owners[1].birth,
        control,
        token,
      })
      let errors = ""
      guard.stderr?.on("data", (data: Buffer) => {
        if (errors.length < 65536) errors += data.toString()
      })
      const closed = new Promise<number>((resolve) => guard.once("exit", (code) => resolve(code ?? 1)))
      try {
        await wait(control + ".job").catch((err) => {
          throw new Error(`${String(err)}: ${errors}`)
        })
        expect(JSON.parse(await readFile(control + ".job", "utf8"))).toEqual({
          version: 2,
          token,
          proof: "windows-job",
          assigned: true,
        })
        expect(await BackgroundProcessRunner.contained(control, token)).toBe(true)
        expect(await BackgroundProcessRunner.contained(control, randomUUID())).toBe(false)
        await writeFile(control + ".go", "go")
        await wait(path.join(dir, "leaf-ready"))
        await exited
        const pid = Number(await readFile(path.join(dir, "leaf-ready"), "utf8"))
        expect((await sample(pid)).status).toBe("owned")
        expect(await Bun.file(control + ".drained").exists()).toBe(false)
        if (mode === "stop") await writeFile(control, "stop")
        if (mode === "guardian") guard.kill()
        if (mode === "controller") controller?.kill()
        const code = await closed
        expect(mode === "guardian" ? code !== 0 : code === 0).toBe(true)
        if (mode === "guardian") expect(await Bun.file(control + ".drained").exists()).toBe(false)
        if (mode !== "guardian") expect(await BackgroundProcessRunner.drained(control, token)).toBe(true)
        expect((await sample(pid)).status).toBe("gone")
        expect(await Bun.file(path.join(dir, "late")).exists()).toBe(false)
        await writeFile(control + ".drained", JSON.stringify({ version: 1, token, empty: true }))
        expect(await BackgroundProcessRunner.drained(control, token)).toBe(false)
        await writeFile(control + ".job", JSON.stringify({ version: 1, token, assigned: true }))
        expect(await BackgroundProcessRunner.contained(control, token)).toBe(false)
        await writeFile(control + ".job", "corrupt")
        const error = await BackgroundProcessRunner.contained(control, token).then(
          () => undefined,
          (err: unknown) => err,
        )
        expect(error).toBeInstanceOf(SyntaxError)
      } finally {
        guard.kill()
        controller?.kill()
        child.kill()
        await exited
        await rm(dir, { recursive: true, force: true })
      }
    },
    90000,
  )
