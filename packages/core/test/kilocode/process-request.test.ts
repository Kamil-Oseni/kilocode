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

test("retains timeout failure until the original child naturally finishes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raya-request-owned-"))
  const file = join(dir, "closed")
  try {
    const result = await run(
      `setTimeout(async()=>{await Bun.write(${JSON.stringify(file)}, "original");process.stdout.write("{}");process.stderr.write("drained")},400)`,
      4096,
      200,
    ).catch((err: unknown) => err)
    expect(result).toBeInstanceOf(Error)
    if (!(result instanceof Error)) throw new Error("Original request did not refuse")
    expect(result.message).toMatch(/timed out/)
    expect(await readFile(file, "utf8")).toBe("original")
    expect(await run("process.stdout.write(JSON.stringify({fresh:true}))")).toEqual({ fresh: true })
  } finally {
    expect(dir.startsWith(join(tmpdir(), "raya-request-owned-"))).toBe(true)
    await rm(dir, { recursive: true, force: true })
  }
})

test("drains oversized original output through natural exit without replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raya-request-overflow-"))
  const file = join(dir, "closed")
  try {
    const result = await run(
      `process.stdout.write("x".repeat(100000));setTimeout(async()=>{process.stderr.write("drained");await Bun.write(${JSON.stringify(file)}, "once")},100)`,
      32,
    ).catch((err: unknown) => err)
    expect(result).toBeInstanceOf(Error)
    if (!(result instanceof Error)) throw new Error("Original request did not refuse")
    expect(result.message).toMatch(/exceeded bound/)
    expect(await readFile(file, "utf8")).toBe("once")
  } finally {
    expect(dir.startsWith(join(tmpdir(), "raya-request-overflow-"))).toBe(true)
    await rm(dir, { recursive: true, force: true })
  }
})

test("bounds and drains the original stderr without publishing its contents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raya-request-stderr-"))
  const file = join(dir, "closed")
  try {
    const result = await run(
      `process.stderr.write("private".repeat(10000));setTimeout(async()=>{await Bun.write(${JSON.stringify(file)}, "original");process.stdout.write("{}")},100)`,
      32,
    ).catch((err: unknown) => err)
    expect(result).toBeInstanceOf(Error)
    if (!(result instanceof Error)) throw new Error("Original request did not refuse")
    expect(result.message).toMatch(/exceeded bound/)
    expect(result.message).not.toContain("private")
    expect(await readFile(file, "utf8")).toBe("original")
  } finally {
    expect(dir.startsWith(join(tmpdir(), "raya-request-stderr-"))).toBe(true)
    await rm(dir, { recursive: true, force: true })
  }
})

test("retains timeout and original exit failures together after actual EOF", async () => {
  const result = await run('process.stderr.write("private");setTimeout(()=>process.exit(7),400)', 4096, 200).catch(
    (err: unknown) => err,
  )
  expect(result).toBeInstanceOf(AggregateError)
  if (!(result instanceof AggregateError)) throw new Error("Original failures were not aggregated")
  const errors: unknown[] = result.errors
  expect(errors.some((err) => err instanceof Error && /timed out/.test(err.message))).toBe(true)
  expect(errors.some((err) => err instanceof Error && /could not be verified/.test(err.message))).toBe(true)
  expect(errors.every((err) => err instanceof Error && !err.message.includes("private"))).toBe(true)
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
