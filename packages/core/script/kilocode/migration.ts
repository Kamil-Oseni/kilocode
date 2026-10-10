import fs from "node:fs/promises"
import path from "node:path"
import { statements } from "../../src/kilocode/routine-revocation"

const id = "20261010235900_kilocode-routine-revocation-v1"

function policy() {
  if (!statements.length || statements.some((sql) => !/^CREATE\s+TRIGGER\s+/i.test(sql.trimStart())))
    throw new Error("Routine revocation requires complete trigger statements")
  return statements.join("\n--> statement-breakpoint\n")
}

/** Only the complete fresh schema receives the current trigger policy. */
export function schema(sql: string) {
  return `${sql}\n--> statement-breakpoint\n${policy()}`
}

/** The immutable custom migration is independent of unrelated Drizzle increments. */
export async function migrations(
  directory: string,
  render: (id: string, sql: string) => Promise<string>,
  check = false,
) {
  const file = path.join(directory, `${id}.ts`)
  const expected = `// kilocode_change - new file\n${await render(id, policy())}`
  const current = await fs.readFile(file, "utf8").catch((err: unknown) => {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined
    throw err
  })
  if (current === expected) return
  if (current !== undefined) throw new Error("Immutable Routine revocation migration differs from its policy")
  if (check) throw new Error("Routine revocation migration is missing; run the core migration generator")
  await fs.writeFile(file, expected, { flag: "wx" })
}

export function statement(sql: string, rendered: string) {
  const owned =
    /^CREATE\s+(?:TABLE\s+[`"]?raya_\w+|TRIGGER\s+[`"]?raya_\w+|(?:UNIQUE\s+)?INDEX\s+\S+\s+ON\s+[`"]?raya_\w+)/i.test(
      sql.trimStart(),
    )
  return owned ? `      // kilocode_change start\n${rendered}\n      // kilocode_change end` : rendered
}

export function entry(name: string, rendered: string) {
  return name.includes("kilocode") ? `${rendered} // kilocode_change` : rendered
}
