import { readFileSync, writeFileSync, mkdirSync, renameSync, symlinkSync } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { registerProcessProfile } from "@opencode-ai/core/kilocode/process-profile"

const root = process.env.RAYA_DAEMON_TEST_ROOT!
const mode = process.env.RAYA_DAEMON_CHILD_CASE
const selected = path.join(root, "selected-root")
mkdirSync(selected)
registerProcessProfile([selected])
const exit = process.exit.bind(process)
process.exit = (code): never => {
  const file = process.env.RAYA_DAEMON_RECEIPT!
  const value = JSON.parse(readFileSync(file, "utf8"))
  if (mode === "receipt-malformed") value.roots.inventory = "0".repeat(64)
  if (mode === "receipt-duplicate") value.roots.roots.splice(1, 0, value.roots.roots[0])
  if (mode === "receipt-relative") value.roots.roots[0].path = "relative"
  if (mode === "receipt-flags") value.roots.nativeOwners = 0
  if (mode === "receipt-canonical") {
    const target = path.join(root, "replacement")
    mkdirSync(target)
    renameSync(selected, path.join(root, "previous-root"))
    symlinkSync(target, selected, "junction")
  }
  if (mode !== "receipt-malformed")
    value.roots.inventory = createHash("sha256")
      .update(
        JSON.stringify(
          value.roots.roots.map((item: { kind: string; path: string }) => ({
            ...item,
            path: process.platform === "win32" ? item.path.toLowerCase() : item.path,
          })),
        ),
      )
      .digest("hex")
  writeFileSync(file, JSON.stringify(value))
  return exit(code)
}
const entry = path.resolve("src/index.ts")
process.argv = [process.execPath, entry, ...process.argv.slice(2)]
await import(entry)
throw new Error("Actual CLI serve returned without natural exit")
