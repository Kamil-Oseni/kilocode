import { NativeInputHost } from "../src/services/computer-use/desktop-input-host"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { once } from "node:events"

const path = process.argv[2]
if (!path) throw new Error("Native input broker executable path is required")

const host = new NativeInputHost(path)
await host.start()
try {
  const reply = await host.dispatch(
    {
      windowID: "0x1",
      observationID: "native-check",
      sensitive: false,
      operation: "pointer",
      action: "move",
      x: 0.5,
      y: 0.5,
    },
    {
      windowID: "0x1",
      identity: "A".repeat(64),
      location: "pid:1;title:Invalid;bounds:0,0,100,100",
      scene: 1,
      observedAt: Date.now(),
      validUntil: Date.now() + 1000,
    },
  )
  if (reply.type !== "refused" || reply.code !== "changed_target")
    throw new Error(`Native input broker did not refuse a changed foreground target (${reply.type}/${reply.code})`)
  const text = await host.dispatch(
    { windowID: "0x1", observationID: "native-text-check", sensitive: false, operation: "type", text: "é🤖" },
    {
      windowID: "0x1",
      identity: "A".repeat(64),
      location: "pid:1;title:Invalid;bounds:0,0,100,100",
      scene: 2,
      observedAt: Date.now(),
      validUntil: Date.now() + 1000,
    },
  )
  if (text.type !== "refused" || text.code !== "changed_target")
    throw new Error(
      `Native input broker did not bound Unicode text to the foreground target (${text.type}/${text.code})`,
    )
} finally {
  await host.cancel()
  host.close()
}
const broken = new NativeInputHost(path)
await broken.start()
const lostChild = (broken as unknown as { child: ChildProcessWithoutNullStreams }).child
const exited = once(lostChild, "close")
lostChild.stdout.destroy()
let failed = false
try {
  await broken.dispatch(
    { windowID: "0x1", observationID: "pipe-loss", sensitive: false, operation: "pointer", action: "move", x: 0, y: 0 },
    {
      windowID: "0x1",
      identity: "A".repeat(64),
      location: "pid:1;title:Invalid;bounds:0,0,100,100",
      scene: 1,
      observedAt: Date.now(),
      validUntil: Date.now() + 1000,
    },
  )
} catch (error) {
  failed = error instanceof Error && /outcome is unknown/.test(error.message)
}
const [lost] = await exited
broken.close()
if (!failed || lost !== 9) throw new Error(`Native input broker did not terminate after output loss (exit ${lost})`)
const child = spawn(path, [], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] })
child.stdin.end(Buffer.from([0x01, 0x10, 0x00, 0x00]))
let timer: NodeJS.Timeout | undefined
const timeout = new Promise<never>((_, reject) => {
  timer = setTimeout(() => {
    child.kill()
    reject(new Error("Native input broker did not refuse an oversized frame promptly"))
  }, 2_000)
})
const [code] = await Promise.race([once(child, "close"), timeout]).finally(() => clearTimeout(timer))
if (code !== 5) throw new Error(`Native input broker accepted an oversized frame (exit ${code})`)
console.log("native input host round trip passed")
