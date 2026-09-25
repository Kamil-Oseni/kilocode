import { NativeInputHost } from "../src/services/computer-use/desktop-input-host"

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
console.log("native input host round trip passed")
