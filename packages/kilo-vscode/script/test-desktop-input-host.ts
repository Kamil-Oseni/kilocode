import { NativeInputHost } from "../src/services/computer-use/desktop-input-host"
import { spawn } from "node:child_process"
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
      pid: 1,
      identity: "A".repeat(64),
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
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
      pid: 1,
      identity: "A".repeat(64),
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
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
