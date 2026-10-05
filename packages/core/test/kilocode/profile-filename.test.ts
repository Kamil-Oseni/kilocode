import { expect, test as check } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Schema } from "effect"
import { Database } from "bun:sqlite"

const profiles = new AsyncLocalStorage<string[]>()
function test(name: string, body: () => Promise<void>) {
  check(
    name,
    () =>
      profiles.run([], async () => {
        const dirs = profiles.getStore()!
        try {
          await body()
        } catch (err) {
          for (const dir of dirs) {
            await fs.writeFile(path.join(dir, "failure.txt"), String(err))
            console.error(`Retained canonical constructor profile: ${dir}`)
          }
          throw err
        }
        for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true })
      }),
    30_000,
  )
}
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "raya-profile-filename-"))
  profiles.getStore()?.push(dir)
  const left = path.join(dir, "left")
  const right = path.join(dir, "right")
  const alias = path.join(dir, "alias")
  await Promise.all([fs.mkdir(left), fs.mkdir(right)])
  await fs.symlink(left, alias, process.platform === "win32" ? "junction" : "dir")
  return { dir, left, right, alias }
}
for (const runtime of ["bun", "node"])
  for (const mode of ["native", "core", "layer"])
    test(`${runtime} ${mode} pins construction and metadata while an independent process retargets the original alias`, async () => {
      const tmp = await fixture()
      const entry = path.join(import.meta.dir, `fixture/profile-filename.${runtime}.ts`)
      const bundle = path.join(tmp.dir, "fixture.mjs")
      if (runtime === "node") {
        const built = await Bun.build({ entrypoints: [entry], target: "node", format: "esm", conditions: ["node"] })
        expect(built.success).toBe(true)
        await Bun.write(bundle, built.outputs[0])
      }
      const ready = path.join(tmp.dir, "ready.json")
      const release = path.join(tmp.dir, "release")
      const child = Bun.spawn(
        [
          runtime === "bun" ? process.execPath : "node",
          runtime === "bun" ? entry : bundle,
          JSON.stringify({ alias: path.join(tmp.alias, "selected.db"), ready, release, mode }),
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
          env: {
            ...process.env,
            NODE_NO_WARNINGS: "1",
            XDG_DATA_HOME: path.join(tmp.dir, "data"),
            XDG_CONFIG_HOME: path.join(tmp.dir, "config"),
            XDG_CACHE_HOME: path.join(tmp.dir, "cache"),
            XDG_STATE_HOME: path.join(tmp.dir, "state"),
            KILO_TEST_HOME: tmp.dir,
          },
        },
      )
      const stdout = new Response(child.stdout).text()
      const stderr = new Response(child.stderr).text()
      const deadline = performance.now() + 15_000
      try {
        while (!(await Bun.file(ready).exists())) {
          if (child.exitCode !== null) throw new Error(`Canonical child exited before selection: ${await stderr}`)
          if (performance.now() >= deadline) throw new Error("Canonical constructor selection timed out")
          await Bun.sleep(10)
        }
        const selected = Schema.decodeUnknownSync(Schema.Struct({ file: Schema.String }))(await Bun.file(ready).json())
        expect(selected.file).toBe(path.join(await fs.realpath(tmp.left), "selected.db"))
        expect(await Bun.file(selected.file).exists()).toBe(false)
        await fs.unlink(tmp.alias)
        await fs.symlink(tmp.right, tmp.alias, process.platform === "win32" ? "junction" : "dir")
        expect(await fs.realpath(tmp.alias)).toBe(await fs.realpath(tmp.right))
        await fs.writeFile(release, "release")
        expect(await child.exited, await stderr).toBe(0)
        const result: unknown = JSON.parse(await stdout)
        expect(result).toMatchObject({
          file: selected.file,
          result: { value: "selected" },
          active: mode === "native" ? 0 : 1,
          owners: [],
        })
        expect(await fs.readdir(tmp.right)).toEqual([])
        using db = new Database(selected.file, { readonly: true })
        expect(db.query("SELECT * FROM canonical_fixture").get()).toEqual({ value: "selected" })
        const dir = path.join(tmp.left, ".raya-profile-locks")
        const names = await fs.readdir(dir)
        const markers = await Promise.all(
          names
            .filter((name) => name.endsWith(".owners") || name.endsWith(".writers"))
            .map((name) => fs.readdir(path.join(dir, name))),
        )
        expect(markers.flat()).toEqual([])
      } finally {
        if (child.exitCode === null) child.kill()
        const code = await child.exited
        await fs.writeFile(
          path.join(tmp.dir, "child.json"),
          JSON.stringify({ runtime, mode, pid: child.pid, code, stdout: await stdout, stderr: await stderr }),
        )
      }
    })
