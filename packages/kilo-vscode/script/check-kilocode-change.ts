// raya_change - cross-platform guard for Kilo markers in Raya-owned packages
import path from "node:path"
import { readdir } from "node:fs/promises"

const roots = [path.resolve(import.meta.dir, ".."), path.resolve(import.meta.dir, "../../kilo-ui")]
const keyword = ["kilocode", "change"].join("_")
const violations: string[] = []
const ignored = new Set([
  "node_modules",
  "dist",
  "bin",
  "test-results",
  ".serve",
  "tmp",
  "coverage",
  ".kilo-dev",
  ".vscode-test",
])
const extensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".css",
  ".scss",
  ".json",
  ".jsonc",
  ".html",
  ".svg",
  ".sh",
  ".ps1",
  ".yml",
  ".yaml",
])

async function scan(root: string, dir = root): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (ignored.has(entry.name)) continue
      await scan(root, path.join(dir, entry.name))
      continue
    }
    if (!entry.isFile()) continue
    const file = path.relative(root, path.join(dir, entry.name)).replaceAll("\\", "/")
    if (
      file === "package.json" ||
      file.endsWith(".md") ||
      file === "webview-ui/preview/index.js" ||
      !extensions.has(path.extname(entry.name))
    )
      continue
    const text = await Bun.file(path.join(dir, entry.name)).text()
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!line.includes(keyword) || line.includes(`\`${keyword}\``)) continue
      violations.push(`${path.relative(process.cwd(), path.join(dir, entry.name))}:${index + 1}:${line}`)
    }
  }
}

for (const root of roots) await scan(root)

if (violations.length === 0) {
  console.log("No forbidden Kilo change markers found.")
  process.exit(0)
}

console.error(violations.join("\n"))
process.exit(1)
