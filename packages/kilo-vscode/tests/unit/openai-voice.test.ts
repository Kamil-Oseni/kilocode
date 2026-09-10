import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { resolve } from "node:path"

test("native OpenAI transport owns local WebRTC media and fences late setup", async () => {
  const child = spawn("node", ["tests/fixtures/openai-voice.mjs"], {
    cwd: resolve(import.meta.dir, "../.."),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const chunks: Buffer[] = []
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
  child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk))
  const timer = setTimeout(() => child.kill(), 45_000)
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject)
    child.on("exit", resolve)
  }).finally(() => clearTimeout(timer))
  const output = Buffer.concat(chunks).toString()
  expect(output).toContain("31 implementation assertions passed")
  expect(code).toBe(0)
}, 50_000)
