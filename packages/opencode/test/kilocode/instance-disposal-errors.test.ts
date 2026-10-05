import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { disposeInstance, registerDisposer } from "../../src/effect/instance-registry"

test("instance disposal joins every finalizer and retains synchronous and filesystem failures", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-disposal-errors-"))
  const file = path.join(dir, "completed")
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const err = new Error("synchronous cleanup failure")
  const off = [
    registerDisposer((directory) => {
      if (directory !== dir) return Promise.resolve()
      throw err
    }),
    registerDisposer(async (directory) => {
      if (directory !== dir) return
      entered.resolve()
      await gate.promise
      await writeFile(file, "finished", { flag: "wx" })
      await writeFile(file, "replacement", { flag: "wx" })
    }),
  ]
  const state = { settled: false }
  const pending = disposeInstance(dir)
    .then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    )
    .finally(() => {
      state.settled = true
    })
  try {
    await entered.promise
    expect(state.settled).toBe(false)
    gate.resolve()
    const result = await pending
    expect(result.error).toBeInstanceOf(AggregateError)
    assert(result.error instanceof AggregateError)
    const errors: unknown[] = result.error.errors
    expect(errors).toHaveLength(2)
    expect(errors[0]).toBe(err)
    const error = errors[1]
    assert(error && typeof error === "object" && "code" in error)
    expect(error.code).toBe("EEXIST")
    expect(await readFile(file, "utf8")).toBe("finished")
  } finally {
    gate.resolve()
    await pending
    off.forEach((remove) => remove())
    await unlink(file)
    await rmdir(dir)
  }
})

test("a single cleanup failure preserves its original identity", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-disposal-errors-"))
  const err = new Error("original finalizer failure")
  const off = registerDisposer((directory) => (directory === dir ? Promise.reject(err) : Promise.resolve()))
  try {
    const result = await disposeInstance(dir).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(result).toBe(err)
  } finally {
    off()
    await rmdir(dir)
  }
})
