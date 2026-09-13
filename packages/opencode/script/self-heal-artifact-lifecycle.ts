// kilocode_change - new file
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const proc = Bun.spawn(
  [
    process.execPath,
    "test",
    "./test/kilocode/self-heal-completion.test.ts",
    "--test-name-pattern",
    "subsequent source changes: false",
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
      KILO_EXPERIMENTAL_EVENT_SYSTEM: "true",
      DO_NOT_TRACK: "1",
    },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  },
)

const timer = setTimeout(() => proc.kill(), 45_000)
timer.unref()
const code = await proc.exited.finally(() => clearTimeout(timer))
if (code !== 0) throw new Error(`Self-heal artifact lifecycle exited with code ${code}.`)

console.log("Self-heal artifact lifecycle returned a verified review artifact and exited cleanly.")
