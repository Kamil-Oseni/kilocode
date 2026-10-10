import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import z from "zod"
import { SourcePolicySchema } from "@opencode-ai/core/kilocode/source-policy"

const result = z
  .object({
    policy: SourcePolicySchema.refine((value) => value.directories.length + value.files.length <= 128),
    observed: z
      .array(
        z
          .string()
          .min(1)
          .max(4096)
          .refine((value) => path.isAbsolute(value) && !/[\0\r\n]/.test(value)),
      )
      .min(1)
      .max(128),
    terminal: z.literal(true),
    portableCaptureAuthorized: z.literal(false),
  })
  .strict()

async function drain(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const state = { bytes: 0, eof: false }
  const hash = createHash("sha256")
  const chunks: Buffer[] = []
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) {
        state.eof = true
        break
      }
      hash.update(next.value)
      const remaining = Math.max(0, 65536 - state.bytes)
      state.bytes += next.value.byteLength
      if (remaining) chunks.push(Buffer.from(next.value).subarray(0, remaining))
    }
  } finally {
    reader.releaseLock()
  }
  return { ...state, sha256: hash.digest("hex"), text: Buffer.concat(chunks).toString("utf8") }
}

test("actual account-overridden ConfigPublication writer remains inside its prepared origin policy and retires", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-config-policy-publication-")))
  const child = Bun.spawn(
    [process.execPath, "--conditions=browser", path.join(import.meta.dir, "fixtures/source-config-policy.ts"), root],
    { cwd: path.resolve(import.meta.dir, "../.."), stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
  )
  const stdout = drain(child.stdout)
  const stderr = drain(child.stderr)
  const [code, output, errors] = await Promise.all([child.exited, stdout, stderr])
  const evidence = { pid: child.pid, code, stdout: output, stderr: errors, joined: true, forced: false }
  await writeFile(path.join(root, "original-result.json"), JSON.stringify(evidence))
  expect(code).toBe(0)
  expect(output.eof).toBe(true)
  expect(errors.eof).toBe(true)
  expect(output.bytes).toBeLessThanOrEqual(65536)
  expect(errors.bytes).toBe(0)
  const value = result.parse(JSON.parse(output.text))
  expect(value.terminal).toBe(true)
  expect(value.observed.length).toBeGreaterThan(0)
  expect(value.portableCaptureAuthorized).toBe(false)
  expect(path.dirname(root)).toBe(path.resolve(await realpath(os.tmpdir())))
  expect(path.basename(root).startsWith("raya-config-policy-publication-")).toBe(true)
  await rm(root, { recursive: true })
}, 20000)
