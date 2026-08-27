// raya_change - isolate Windows test files from Bun's process-wide module and timer state
import path from "node:path"

const root = path.join(import.meta.dir, "..")
const tests = path.join(root, "tests", "unit")

async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, "test", ...args, "--dots"], {
    cwd: root,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  return child.exited
}

if (process.platform !== "win32") {
  process.exit(await run([tests]))
}

const glob = new Bun.Glob("**/*.test.ts")
const files = Array.fromAsync(glob.scan({ cwd: tests, absolute: true })).then((items) => items.sort())

for (const file of await files) {
  const code = await run([file])
  if (code !== 0) process.exit(code)
}
