import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { cp, mkdtemp, mkdir, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { coordinateNativeRoots, registerProfileFile } from "../../src/kilocode/profile-maintenance"
import { logRoot } from "../../src/kilocode/log-root"

async function profile() {
  const root = await mkdtemp(path.join(tmpdir(), "raya-canonical-log-owner-"))
  await mkdir(path.join(root, "selected"))
  await mkdir(path.join(root, "unused"))
  return root
}
function launch(root: string, dir: string, mode: string) {
  const env = { ...process.env }
  for (const key of Object.keys(env))
    if (key.startsWith("OTEL_") || /(API_KEY|TOKEN|SECRET)$/.test(key)) delete env[key]
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    KILO_TEST_HOME: root,
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    RAYA_DB: path.join(root, "raya.db"),
    KILO_DB: path.join(root, "raya.db"),
    RAYA_AUTH_CONTENT: "{}",
    KILO_AUTH_CONTENT: "{}",
  })
  const marker = crypto.randomUUID()
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "fixture/log-root-owner.ts"), dir, mode, marker],
    { env, stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true },
  )
  const reader = child.stdout.getReader()
  const stderr = new Response(child.stderr).text()
  let text = ""
  async function receipt() {
    while (!text.includes("\n")) {
      const item = await reader.read()
      if (item.done) throw new Error(`Native child ended before receipt: ${await stderr}`)
      text += new TextDecoder().decode(item.value)
    }
    const index = text.indexOf("\n")
    const line = text.slice(0, index)
    text = text.slice(index + 1)
    return JSON.parse(line)
  }
  return {
    child,
    marker,
    stderr,
    receipt,
    async cleanup() {
      if (child.exitCode === null) {
        try {
          await child.stdin.write("close\n")
          await child.stdin.end()
        } catch (err) {
          if (!(err instanceof Error) || !("code" in err) || err.code !== "EPIPE") throw err
          console.error(`Child input already closed; retaining failure diagnostics: ${root}`)
        }
      }
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill()
      }, 5_000)
      try {
        await child.exited
      } finally {
        clearTimeout(timer)
      }
      await writeFile(path.join(root, `${mode}.stderr.log`), await stderr)
    },
  }
}

for (const mode of ["legacy", "effect"])
  test(`${mode} native idle logger blocks cross-process capture; canonical alias stays pinned through close`, async () => {
    const root = await profile()
    const selected = path.join(root, "selected")
    const bytes = Buffer.from([0, 255, 128, 13, 10, 123, 32, 195, 169])
    await writeFile(path.join(selected, "opaque.bin"), bytes)
    const alias = path.join(root, "alias")
    await symlink(selected, alias, process.platform === "win32" ? "junction" : "dir")
    const peer = launch(root, alias, mode)
    try {
      const ready = await peer.receipt()
      expect(ready.ready).toBe(true)
      expect(ready.roots).toEqual([{ kind: "json", path: selected }])
      await assert.rejects(
        coordinateNativeRoots(ready.roots, async () => {
          throw new Error("Live native capture body ran")
        }),
        /remain live/,
      )
      await unlink(alias)
      await symlink(path.join(root, "unused"), alias, process.platform === "win32" ? "junction" : "dir")
      await peer.child.stdin.write("close\n")
      await peer.child.stdin.end()
      const closed = await peer.receipt()
      expect(closed.passed).toBe(true)
      expect(await peer.child.exited).toBe(0)
      expect(() => process.kill(peer.child.pid, 0)).toThrow()
      expect((await readFile(closed.file, "utf8")).includes(peer.marker)).toBe(true)
      expect(await readdir(path.join(root, "unused"))).toEqual([])
      const result = await coordinateNativeRoots(ready.roots, async (admission) => {
        expect(() => registerProfileFile({ kind: "json", path: selected })).toThrow("maintenance excludes")
        expect(admission).toMatchObject({ nativeOwners: 0, operations: 0, portableCaptureAuthorized: false })
        const blocked = launch(root, selected, "refused")
        try {
          expect(await blocked.receipt()).toEqual({ passed: true, mode: "refused", roots: [] })
          expect(await blocked.child.exited).toBe(0)
          expect(() => process.kill(blocked.child.pid, 0)).toThrow()
        } finally {
          await blocked.cleanup()
        }
        const capture = path.join(root, "cooperative-copy")
        await cp(selected, capture, { recursive: true })
        expect(await readFile(path.join(capture, "opaque.bin"))).toEqual(bytes)
        expect(await readFile(path.join(capture, path.basename(closed.file)))).toEqual(await readFile(closed.file))
        return "actual closed participants"
      })
      expect(result.value).toBe("actual closed participants")
    } catch (err) {
      console.error(`Retained log-owner profile ${root}`)
      throw err
    } finally {
      await peer.cleanup()
    }
  }, 20_000)

test("native file marker cleanup failure refuses zero ownership rather than removing changed evidence", async () => {
  const root = await profile()
  const selected = path.join(root, "selected")
  const owner = logRoot(selected)
  owner.finish()
  const locks = path.join(root, ".raya-profile-locks")
  const dirs = await readdir(locks)
  const folder = dirs.find((name) => name.endsWith(".owners"))!
  const file = path.join(locks, folder, (await readdir(path.join(locks, folder)))[0])
  await writeFile(file, "changed unknown ownership")
  expect(() => owner.close()).toThrow("changed native ownership")
  await assert.rejects(coordinateNativeRoots([{ kind: "json", path: selected }], async () => "must refuse"))
  expect(await readFile(file, "utf8")).toBe("changed unknown ownership")
})

test("unused logger retirement records no roots and creates no selected native file", async () => {
  const root = await profile()
  const peer = launch(root, path.join(root, "not-realized"), "unused")
  try {
    expect(await peer.receipt()).toEqual({ passed: true, mode: "unused", roots: [] })
    expect(await peer.child.exited).toBe(0)
    expect(await Bun.file(path.join(root, "not-realized", "dev.log")).exists()).toBe(false)
  } finally {
    await peer.cleanup()
  }
})
