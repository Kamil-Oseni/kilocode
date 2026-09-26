import { spawn } from "node:child_process"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { NativeCaptureHost } from "../src/services/computer-use/desktop-native-host"

const binary = Bun.argv[2]
if (process.platform !== "win32" || !binary) throw new Error("Pass a compiled Windows native capture helper")

const fixture = spawn(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-STA",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(import.meta.dir, "computer-use-native-foreground-fixture.ps1"),
  ],
  { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
)
const lines: string[] = []
let wake: ((line: string) => void) | undefined
let stderr = ""
createInterface({ input: fixture.stdout! }).on("line", (line) => {
  if (wake) {
    const done = wake
    wake = undefined
    done(line)
    return
  }
  lines.push(line)
})
fixture.stderr?.on("data", (chunk: Buffer) => {
  stderr = (stderr + chunk.toString()).slice(-2_000)
})

function next(): Promise<string> {
  if (lines.length) return Promise.resolve(lines.shift()!)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      wake = undefined
      reject(new Error(`Foreground fixture did not respond: ${stderr}`))
    }, 8_000)
    wake = (line) => {
      clearTimeout(timer)
      resolve(line)
    }
  })
}

let report: (error: Error) => void = () => undefined
const failed = new Promise<Error>((resolve) => {
  report = resolve
})
const host = new NativeCaptureHost(binary, report)
try {
  const ready = await next()
  if (ready !== "READY") throw new Error(`Foreground fixture could not take focus: ${ready}; ${stderr}`)
  host.start()
  const frame = await Promise.race([
    host.next(),
    Bun.sleep(8_000).then(() => {
      throw new Error("Native capture did not observe fixture A")
    }),
  ])
  try {
    if (!frame.location.includes("Raya capture fixture A"))
      throw new Error(`Native capture bound the wrong foreground: ${frame.location}`)
  } finally {
    frame.data.fill(0)
  }
  fixture.stdin?.write("flash\n")
  const flashed = await next()
  if (flashed !== "FLASHED") throw new Error(`Foreground fixture could not switch A to B to A: ${flashed}; ${stderr}`)
  const outcome = await Promise.race([failed, Bun.sleep(2_000).then(() => undefined)])
  if (!outcome || !/target_changed/.test(outcome.message))
    throw new Error(
      `Native capture did not invalidate A after a fast A-B-A switch: ${outcome?.message ?? "no failure"}`,
    )
  console.log(
    JSON.stringify({
      format: "raya.native-foreground-continuity",
      version: 1,
      status: "passed",
      result: outcome.message,
    }),
  )
} finally {
  host.stop()
  fixture.stdin?.write("quit\n")
  await Promise.race([
    new Promise<void>((resolve) => fixture.once("close", () => resolve())),
    Bun.sleep(1_000).then(() => fixture.kill()),
  ])
}
