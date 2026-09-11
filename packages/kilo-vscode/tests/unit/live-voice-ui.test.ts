import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { resolve } from "node:path"

test("Live VoiceProvider retains the task agent and correlates control acknowledgements", async () => {
  const child = spawn("node", ["tests/fixtures/live-voice-ui.mjs"], {
    cwd: resolve(import.meta.dir, "../.."),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const chunks: Buffer[] = []
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
  child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk))
  const timer = setTimeout(() => child.kill(), 120_000)
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject)
    child.on("exit", resolve)
  }).finally(() => clearTimeout(timer))
  const output = Buffer.concat(chunks).toString()
  expect(output).toContain("18 implementation assertions passed")
  expect(code).toBe(0)
}, 130_000)
