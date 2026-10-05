import { expect, test } from "bun:test"
import { command } from "../../src/second-brain/control/command"
import path from "node:path"
import { tmpdir } from "node:os"

test("Memory helper retains a missed observation as failure after natural exit and both EOF", async () => {
  const error = await command(
    process.execPath,
    ["-e", "setTimeout(()=>{process.stdout.write('late');process.stderr.write('drained')},120)"],
    {},
    20,
  ).then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(error).toBeInstanceOf(AggregateError)
  expect(error).toMatchObject({
    receipt: {
      code: 0,
      signal: null,
      stdoutEOF: true,
      stderrEOF: true,
      originalJoined: true,
      readersJoined: true,
      observationExpired: true,
      forced: false,
    },
  })
  expect((error as AggregateError).errors.some((err: Error) => err.message.includes("observation expired"))).toBe(true)
})

test("Memory helper drains oversized genuine output without killing the original child", async () => {
  const error = await command(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(70000));setTimeout(()=>process.stderr.write('after'),100)"],
    {},
  ).then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(error).toBeInstanceOf(AggregateError)
  expect(error).toMatchObject({
    receipt: {
      code: 0,
      signal: null,
      stdoutBytes: 70000,
      stderrBytes: 5,
      stdoutEOF: true,
      stderrEOF: true,
      readersJoined: true,
      forced: false,
    },
  })
  expect(
    (error as AggregateError).errors.some((err: Error) => err.message.includes("exceeded observation bound")),
  ).toBe(true)
})

test("Memory helper preserves nonzero original exit and drained stderr", async () => {
  const error = await command(
    process.execPath,
    ["-e", "process.stderr.write('synthetic');process.exitCode=7"],
    {},
  ).then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(error).toBeInstanceOf(AggregateError)
  expect(error).toMatchObject({
    receipt: {
      code: 7,
      signal: null,
      stderrBytes: 9,
      stdoutEOF: true,
      stderrEOF: true,
      originalJoined: true,
      forced: false,
    },
  })
})

test("Memory helper returns bounded successful bytes only after all original joins", async () => {
  const value = await command(process.execPath, ["-e", "process.stdout.write('ok');process.stderr.write('note')"], {})
  expect(value.stdout).toBe("ok")
  expect(value.stderr).toBe("note")
  expect(value.receipt).toMatchObject({
    code: 0,
    stdoutEOF: true,
    stderrEOF: true,
    originalJoined: true,
    readersJoined: true,
    observationExpired: false,
    forced: false,
  })
})

test("Memory helper retains actual spawn error and failed-child reader closure", async () => {
  const file = path.join(tmpdir(), "raya-absent-helper-" + crypto.randomUUID(), "absent.exe")
  const error = await command(file, [], {}).then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(error).toBeInstanceOf(AggregateError)
  expect(error).toMatchObject({ receipt: { pid: null, originalJoined: true, readersJoined: true, forced: false } })
  expect((error as AggregateError).errors.some((err: NodeJS.ErrnoException) => err.code === "ENOENT")).toBe(true)
})
