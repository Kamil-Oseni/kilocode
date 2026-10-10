import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { drain } from "../fixtures/profile-source-streams"

test("actual local VoiceProvider waits for original player drain and echo tail without barge-in", async () => {
  const child = spawn("node", ["tests/fixtures/voice-half-duplex.mjs"], {
    cwd: resolve(import.meta.dir, "../.."),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const stdout = drain(child.stdout)
  const stderr = drain(child.stderr)
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject)
    child.on("close", resolve)
  })
  const streams = await Promise.all([stdout, stderr])
  expect(streams.every((stream) => stream.EOF && stream.joined)).toBe(true)
  expect(streams[0]!.tail + streams[1]!.tail).toContain("17 actual half-duplex provider assertions passed")
  expect(code).toBe(0)
}, 60_000)
