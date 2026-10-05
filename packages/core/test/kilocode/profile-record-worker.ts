import { linkSync, readdirSync } from "node:fs"
import path from "node:path"
import { admitProfileOperation, registerProfileFile } from "../../src/kilocode/profile-maintenance"

const root = { kind: "json" as const, path: process.argv[2] }
const dir = path.join(path.dirname(root.path), ".raya-profile-locks")
for (let i = 0; i < (process.argv[3] === "alias" ? 1 : 10000); i++) {
  registerProfileFile(root)
  admitProfileOperation(root)
  if (process.argv[3] === "alias") {
    for (const name of readdirSync(dir).filter((name) => name.endsWith(".owners") || name.endsWith(".writers"))) {
      const file = readdirSync(path.join(dir, name))[0]
      linkSync(path.join(dir, name, file), path.join(dir, `.abandoned-${name.split(".").at(-1)}.pending`))
    }
    console.log("ready")
    process.exit(0)
  }
  if (i === 8) console.log("ready")
}
