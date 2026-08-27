// raya_change - cross-platform guard for Kilo markers in Raya-owned packages
import path from "node:path"

const roots = [path.resolve(import.meta.dir, ".."), path.resolve(import.meta.dir, "../../kilo-ui")]
const keyword = ["kilocode", "change"].join("_")
const violations: string[] = []

for (const root of roots) {
  const glob = new Bun.Glob("**/*")
  for await (const file of glob.scan({ cwd: root, dot: true, onlyFiles: true })) {
    const normalized = file.replaceAll("\\", "/")
    if (
      normalized === "package.json" ||
      normalized.endsWith(".md") ||
      normalized.includes("/node_modules/") ||
      normalized.startsWith("node_modules/") ||
      normalized.includes("/dist/") ||
      normalized.startsWith("dist/") ||
      normalized.startsWith("bin/")
    ) {
      continue
    }

    const text = await Bun.file(path.join(root, file)).text()
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!line.includes(keyword) || line.includes(`\`${keyword}\``)) continue
      violations.push(`${path.relative(process.cwd(), path.join(root, file))}:${index + 1}:${line}`)
    }
  }
}

if (violations.length === 0) {
  console.log("No forbidden Kilo change markers found.")
  process.exit(0)
}

console.error(violations.join("\n"))
process.exit(1)
