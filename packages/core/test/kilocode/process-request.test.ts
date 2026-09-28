import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request } from "../../src/kilocode/process-host/request"

const run = (source: string, bound = 4096, timeout = 5000) => request(process.execPath, ["-e", source], bound, timeout)

test("validates actual native-shaped child replies without returning private failures", async () => {
  expect(await run('process.stdout.write(JSON.stringify({version:1,proof:"windows-job"}))')).toEqual({
    version: 1,
    proof: "windows-job",
  })
  await expect(run('process.stderr.write("private");process.exit(7)')).rejects.toThrow(/could not be verified/)
  await expect(run('process.stdout.write("private invalid json")')).rejects.toThrow(/response invalid/)
  await expect(run("process.stdout.write(Buffer.from([0xff]))")).rejects.toThrow(/response invalid/)
  await expect(run('process.stdout.write("x".repeat(1000))', 32)).rejects.toThrow(/exceeded bound/)
}, 30_000)

test("kills only a timed-out child and permits a fresh independent request", async () => {
  await expect(run('setTimeout(()=>process.stdout.write("{}"),10000)', 4096, 100)).rejects.toThrow(/timed out/)
  expect(await run("process.stdout.write(JSON.stringify({fresh:true}))")).toEqual({ fresh: true })
})

test("does not start native work queued beyond its monotonic deadline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raya-request-"))
  const file = join(dir, "started")
  try {
    const pending = run(`await Bun.write(${JSON.stringify(file)}, "started");process.stdout.write("{}")`, 4096, 10)
    const result = pending.catch((err: unknown) => err)
    const until = performance.now() + 40
    while (performance.now() < until) continue
    expect(await result).toBeInstanceOf(Error)
    expect(((await result) as Error).message).toMatch(/timed out/)
    expect(await Bun.file(file).exists()).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("refuses a real late reply after a blocked event loop without replaying its effect", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raya-request-late-"))
  const file = join(dir, "once")
  try {
    const pending = run(
      `await Bun.write(${JSON.stringify(file)}, "once");setTimeout(()=>process.stdout.write(JSON.stringify({late:true})),100)`,
      4096,
      2000,
    )
    const result = pending.catch((err: unknown) => err)
    const ready = performance.now() + 1000
    while (!(await Bun.file(file).exists()) && performance.now() < ready) await Bun.sleep(5)
    expect(await Bun.file(file).exists()).toBe(true)
    const until = performance.now() + 2100
    while (performance.now() < until) continue
    expect(((await result) as Error).message).toMatch(/timed out/)
    expect(await readFile(file, "utf8")).toBe("once")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 10_000)

test("refuses invalid or expanded bounds before child startup", async () => {
  for (const timeout of [0, -1, 15_001, Infinity, 1.5]) await expect(run("", 4096, timeout)).rejects.toThrow(/deadline/)
  for (const bound of [0, -1, 8 * 1024 * 1024 + 1, Infinity, 1.5]) await expect(run("", bound)).rejects.toThrow(/bound/)
})
