import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Flock } from "@opencode-ai/core/util/flock"
import { Hash } from "@opencode-ai/core/util/hash"
import { resolveProfileRoot } from "@opencode-ai/core/kilocode/profile-maintenance"
import { createSequencer } from "@/kilocode/session-export/sequence"
import { closeExportOwners } from "@/kilocode/session-export/cleanup"

test("export cleanup attempts every real native close and retains the refused owner", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-export-all-close-"))
  const first = createSequencer(path.join(dir, "first.db"))
  const second = createSequencer(path.join(dir, "second.db"))
  const roots = await Promise.all(
    ["first", "second"].map((name) => resolveProfileRoot({ kind: "sqlite", path: path.join(dir, `${name}.db`) })),
  )
  const owners = new Map([
    ["workspace-first", first],
    ["workspace-second", second],
  ])
  const locks = path.join(dir, ".raya-profile-locks")
  const held = await Flock.acquire(roots[0].id, { dir: locks })
  let released: Promise<void> | undefined
  const unlock = () => (released ??= held.release())
  expect(() => first.next("retained")).toThrow("maintenance excludes")
  try {
    const errors = closeExportOwners(owners)
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain("workspace-first")
    expect(errors[0].cause).toBeInstanceOf(Error)
    expect([...owners.keys()]).toEqual(["workspace-first"])
    expect((await readdir(path.join(locks, `${Hash.fast(roots[0].id)}.owners`))).length).toBe(1)
    expect(await readdir(path.join(locks, `${Hash.fast(roots[1].id)}.owners`))).toEqual([])
    expect(() => second.next("closed")).toThrow()
    await unlock()
    expect(first.next("retained")).toBe(0)
    expect(closeExportOwners(owners)).toEqual([])
    expect(owners.size).toBe(0)
    expect(await readdir(path.join(locks, `${Hash.fast(roots[0].id)}.owners`))).toEqual([])
  } finally {
    await unlock()
    first.close()
    second.close()
    await rm(dir, { recursive: true, force: true })
  }
})

for (const mode of ["cleanup", "natural"])
  test(`actual export parent ${mode === "cleanup" ? "retains both close errors and sticky refusal" : "joins natural worker exit and closes every native owner without force"}`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "raya-export-sticky-close-"))
    const child = Bun.spawn(
      [process.execPath, "--conditions=browser", path.join(import.meta.dir, `fixtures/${mode}-parent.ts`), dir],
      {
        cwd: path.resolve(import.meta.dir, "../../.."),
        windowsHide: true,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          XDG_DATA_HOME: path.join(dir, "data"),
          XDG_STATE_HOME: path.join(dir, "state"),
          XDG_CACHE_HOME: path.join(dir, "cache"),
          XDG_CONFIG_HOME: path.join(dir, "config"),
          KILO_TEST_HOME: dir,
        },
      },
    )
    const timer = setTimeout(() => child.kill(), 15_000)
    try {
      expect(await child.exited, await new Response(child.stderr).text()).toBe(0)
      expect(await new Response(child.stdout).text()).toContain(mode === "cleanup" ? '"sticky":true' : '"natural":true')
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) {
        child.kill()
        await child.exited
      }
      await rm(dir, { recursive: true, force: true })
    }
  }, 20_000)

for (const mode of ["held", "timeout"])
  test(`unsubscribe failure still drains captures and ${mode === "held" ? "closes settled" : "retains unsettled"} sequencers`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "raya-export-capture-cleanup-"))
    const child = Bun.spawn(
      [process.execPath, "--conditions=browser", path.join(import.meta.dir, "fixtures/capture-cleanup.ts"), dir, mode],
      {
        cwd: path.resolve(import.meta.dir, "../../.."),
        windowsHide: true,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          XDG_DATA_HOME: path.join(dir, "data"),
          XDG_STATE_HOME: path.join(dir, "state"),
          XDG_CACHE_HOME: path.join(dir, "cache"),
          XDG_CONFIG_HOME: path.join(dir, "config"),
          KILO_TEST_HOME: dir,
        },
      },
    )
    const timer = setTimeout(() => child.kill(), 15_000)
    try {
      expect(await child.exited, await new Response(child.stderr).text()).toBe(0)
      expect(await new Response(child.stdout).text()).toContain('"primary":true')
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) {
        child.kill()
        await child.exited
      }
      await rm(dir, { recursive: true, force: true })
    }
  }, 20_000)
