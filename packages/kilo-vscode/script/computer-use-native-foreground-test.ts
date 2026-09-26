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
const resets: Array<{ epoch: number; cleared: boolean }> = []
const host = new NativeCaptureHost(binary, report, [], undefined, undefined, (reset) => {
  resets.push({ epoch: reset.epoch, cleared: host.latest(Infinity) === undefined })
})

async function frame(after: number, title: string, epoch: number) {
  const image = await Promise.race([
    host.next(after),
    Bun.sleep(8_000).then(() => {
      throw new Error(`Native capture did not observe fixture ${title}`)
    }),
  ])
  try {
    if (!image.location.includes(`Raya capture fixture ${title}`))
      throw new Error(`Native capture bound the wrong foreground: ${image.location}`)
    if (image.epoch === undefined || image.epoch <= epoch)
      throw new Error(`Native capture reused epoch ${image.epoch} after ${epoch}`)
    return {
      sequence: image.sequence,
      epoch: image.epoch,
      windowID: image.windowID,
      location: image.location,
      identity: image.identity,
    }
  } finally {
    image.data.fill(0)
  }
}

async function command(value: string, expected: string) {
  const before = resets.length
  fixture.stdin?.write(`${value}\n`)
  const result = await next()
  if (result !== expected) throw new Error(`Foreground fixture ${value} failed: ${result}; ${stderr}`)
  for (let attempt = 0; attempt < 1_600 && resets.length === before; attempt++) await Bun.sleep(5)
  if (resets.length === before) throw new Error(`Native capture did not reset after ${value}`)
}

try {
  const ready = await next()
  if (ready !== "READY") throw new Error(`Foreground fixture could not take focus: ${ready}; ${stderr}`)
  host.start()
  const first = await frame(0, "A", 0)
  const toB = performance.now()
  await command("to-b", "B")
  const second = await frame(first.sequence, "B", first.epoch)
  const bMs = Number((performance.now() - toB).toFixed(2))
  const toA = performance.now()
  await command("to-a", "A")
  const third = await frame(second.sequence, "A", second.epoch)
  const aMs = Number((performance.now() - toA).toFixed(2))
  const toFlash = performance.now()
  await command("flash", "FLASHED")
  const fourth = await frame(third.sequence, "A", third.epoch)
  const flashMs = Number((performance.now() - toFlash).toFixed(2))
  const toResize = performance.now()
  await command("resize", "RESIZED")
  const fifth = await frame(fourth.sequence, "A", fourth.epoch)
  const resizeMs = Number((performance.now() - toResize).toFixed(2))
  if (fifth.location === fourth.location) throw new Error("Native capture reused pre-resize bounds")
  const toRetoken = performance.now()
  await command("retoken", "RETOKENED")
  const sixth = await frame(fifth.sequence, "A", fifth.epoch)
  const retokenMs = Number((performance.now() - toRetoken).toFixed(2))
  if (sixth.windowID !== fifth.windowID || sixth.location !== fifth.location)
    throw new Error("Window changed while testing a same-target instance token")
  if (!fifth.identity || !sixth.identity || fifth.identity === sixth.identity)
    throw new Error("Native capture did not replace the same-window identity after its token changed")
  if (resets.length < 5 || resets.some((reset) => !reset.cleared))
    throw new Error("Native capture did not clear cached pixels at every foreground reset")
  const outcome = await Promise.race([failed, Bun.sleep(50).then(() => undefined)])
  if (outcome) throw outcome
  host.stop()
  if (host.latest(Infinity) || host.pid()) throw new Error("Native capture retained pixels or process after Stop")
  console.log(
    JSON.stringify({
      format: "raya.native-foreground-continuity",
      version: 3,
      status: "passed",
      epochs: [first.epoch, second.epoch, third.epoch, fourth.epoch, fifth.epoch, sixth.epoch],
      resets: resets.length,
      transitionToFrameMs: { b: bMs, a: aMs, flash: flashMs, resize: resizeMs, retoken: retokenMs },
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
