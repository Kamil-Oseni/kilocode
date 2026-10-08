import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { Pipes } from "../../src/second-brain/managed/owner"

async function closed(errors: unknown[], code: number) {
  const row = { format: "raya.memory.disposable.supervisor.closed", passed: code === 0, control_joined: true, errors }
  const script = `process.stdin.resume(); process.stdin.once('data', () => { console.log(${JSON.stringify(JSON.stringify(row))}); process.exit(${code}) })`
  const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
  const pipes = new Pipes(child)
  return pipes.close()
}

test("failed original producer exposes bounded error types after real process and stream closure", async () => {
  await expect(closed(["ValueError", "RuntimeError"], 1)).rejects.toThrow("producer errors: ValueError, RuntimeError")
})

test("producer diagnostics exclude arbitrary messages and credentials", async () => {
  await expect(
    closed(["Bearer private-token", { token: "private-token" }, "A".repeat(81), "a".repeat(64)], 1),
  ).rejects.toThrow("producer errors: Unspecified producer failure")
})

test("successful original producer retains the existing retirement result", async () => {
  const result = await closed([], 0)
  expect(result).toMatchObject({ originalJoined: true, readersJoined: true, producerRetirement: true, forced: false })
})
