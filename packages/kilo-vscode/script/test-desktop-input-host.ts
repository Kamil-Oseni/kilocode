import { NativeInputHost } from "../src/services/computer-use/desktop-input-host"
import { spawn } from "node:child_process"
import { once } from "node:events"

const path = process.argv[2]
if (!path) throw new Error("Native input broker executable path is required")

const host = new NativeInputHost(path)
await host.start()
try {
  const reply = await host.probe({ windowID: "0x1", pid: 1, scene: 1 })
  if (reply.type !== "refused" || reply.code !== "changed_target")
    throw new Error("Native input broker did not refuse a changed foreground target")
  await host.cancel()
} finally {
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
