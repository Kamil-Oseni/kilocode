import { expect, test } from "bun:test"
import { command } from "../../src/second-brain/control/command"
import path from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"

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
    output: { stdout: "", stderr: "synthetic" },
    diagnostic: {
      stderrRetained: 9,
      stderrSHA256: createHash("sha256").update("synthetic").digest("hex"),
      truncated: false,
    },
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
  expect((error as Error).message).toContain("exit=7")
  expect((error as Error).message).not.toContain("synthetic")
  expect(JSON.stringify(error)).not.toContain("synthetic")
})

test("Memory helper failure diagnostics retain only bounded original bytes without exposing private content", async () => {
  const secret = "private-note-Ω-" + crypto.randomUUID()
  const raw = "MemoryError: " + secret.repeat(2000)
  const error = await command(
    process.execPath,
    ["-e", `process.stderr.write('MemoryError: '+${JSON.stringify(secret)}.repeat(2000));process.exitCode=3`],
    {},
    15000,
    1024,
  ).then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(error).toBeInstanceOf(AggregateError)
  expect(error).toMatchObject({
    output: {
      stdout: "",
      stderr: Buffer.from(raw).subarray(0, 1024).toString("utf8"),
      stderrBase64: Buffer.from(raw).subarray(0, 1024).toString("base64"),
    },
    diagnostic: {
      exception: "MemoryError",
      stderrRetained: 1024,
      truncated: true,
      stderrSHA256: createHash("sha256").update(Buffer.from(raw).subarray(0, 1024)).digest("hex"),
    },
    receipt: {
      code: 3,
      stderrBytes: Buffer.byteLength(raw),
      stderrEOF: true,
      originalJoined: true,
      readersJoined: true,
      forced: false,
    },
  })
  expect((error as Error).message).toContain("truncated=true")
  expect((error as Error).message).toContain("stderrClass=MemoryError")
  expect((error as Error).message).not.toContain(secret)
  expect(JSON.stringify(error)).not.toContain(secret)
  expect(Object.keys(error as object)).not.toContain("output")
  expect(Object.getOwnPropertyDescriptor(error, "output")).toMatchObject({ writable: false, configurable: false })
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

test("Memory helper surfaces only the fixed historical guard location after original joins", async () => {
  const raw =
    "Historical capture revision refused; stage=image; line=42; caller=review; caller_line=123; class=FileNotFoundError.\n"
  const error = await command(
    process.execPath,
    ["-e", `process.stderr.write(${JSON.stringify(raw)});process.exitCode=1`],
    {},
  ).catch((err: unknown) => err)
  expect(error).toMatchObject({
    diagnostic: { exception: "FileNotFoundError", stage: "image", line: 42, caller: "review", callerLine: 123 },
    receipt: { originalJoined: true, readersJoined: true, forced: false },
  })
  if (!(error instanceof Error)) throw new Error("Expected the original helper failure")
  expect(error.message).toContain("Historical stage=image; line=42.")
  expect(error.message).toContain("Caller=review; line=123.")
  const secret = "private-path-" + crypto.randomUUID()
  const invalid = raw.replace("caller=review", "caller=" + secret)
  const refusal = await command(
    process.execPath,
    ["-e", `process.stderr.write(${JSON.stringify(invalid)});process.exitCode=1`],
    {},
  ).catch((err: unknown) => err)
  expect(refusal).toMatchObject({ diagnostic: { exception: "unclassified" } })
  if (!(refusal instanceof Error)) throw new Error("Expected the original helper refusal")
  expect(refusal.message).not.toContain(secret)
  expect(JSON.stringify(refusal)).not.toContain(secret)
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
