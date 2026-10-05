import path from "node:path"
import { BackgroundProcess } from "../../../src/kilocode/background-process"
import { provide } from "../../../src/kilocode/instance"
import { SessionID } from "../../../src/session/schema"

const root = process.env.RAYA_DAEMON_TEST_ROOT!
const script = path.join(root, "background-child.ts")
await Bun.write(
  script,
  `import { open } from "node:fs/promises"
const root = process.env.RAYA_DAEMON_TEST_ROOT!
const file = await open(root + "/background-native.log", "a")
await Bun.write(root + "/background-command-pid", String(process.pid))
console.log("RAYA_BACKGROUND_READY")
while (!(await Bun.file(process.env.RAYA_BACKGROUND_CAPTURE_REQUEST!).exists()) && !(await Bun.file(root + "/background-release").exists())) await Bun.sleep(10)
await Bun.write(root + "/background-entered", "entered")
while (!(await Bun.file(root + "/background-release").exists())) await Bun.sleep(10)
try { await file.write("RAYA_DAEMON_BACKGROUND_FINAL_MARKER\\n") } finally { await file.close() }
await Bun.write(root + "/background-closed", "closed")
`,
)
const quote = (value: string) => `"${value.replaceAll("\\", "/").replaceAll('"', '""')}"`
await provide({
  directory: root,
  fn: async () => {
    const info = await BackgroundProcess.start({
      sessionID: SessionID.descending(),
      lifetime: "persistent",
      command: `& ${quote(process.execPath)} ${quote(script)}`,
      cwd: root,
      ready: { pattern: "RAYA_BACKGROUND_READY", timeout: 10000 },
    })
    await Bun.write(path.join(root, "background-supervisor-pid"), String(info.pid))
  },
})
const entry = path.resolve("src/index.ts")
process.argv = [process.execPath, entry, ...process.argv.slice(2)]
await import(entry)
throw new Error("Actual CLI serve returned without natural outer exit")
