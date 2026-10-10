import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { isolate } from "../../../src/kilocode/migration/profile-import-isolation"

await isolate()
async function prepare() {
  const { seal } = await import("../../../src/kilocode/migration/profile-bundle")
  const root = process.argv[2]
  const count = Number(process.argv[3] ?? "2")
  const workspaces = Array.from({ length: count }, (_, index) =>
    process.argv[4] === "wide" ? `/${"😀".repeat(2045)}${index}` : `C:/original/café-日本語-😀-${index}`,
  )
  const source = "C:/original/repository/.git"
  const common = createHash("sha256").update(source.toLowerCase()).digest("hex")
  const value = {
    format: "raya.profile-data" as const,
    version: 1 as const,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    schema: "a".repeat(64),
    workspaces,
    sql: [{ table: "session" as const, columns: ["directory"], rows: workspaces.map((item) => [item]) }],
    json: [{ path: "raya/goal/example.json", value: '{"private":"PRIVATE_NOTE_NOT_METADATA"}' }],
    artifacts: {
      version: 1 as const,
      repositories: [{ id: common, source, files: [], directories: [], alternates: [], objectFormat: "sha1" as const }],
      snapshots: [],
      worktrees: count
        ? [
            {
              project: "project-日本語",
              name: "branch-café",
              workspace: workspaces[0],
              common,
              admin: [],
              adminDirectories: [],
              files: [],
              directories: [],
            },
          ]
        : [],
    },
    review: { reconnectCredentials: true as const, uncertainWork: "held-no-replay" as const },
  }
  const bytes = await seal(value, "test private review passphrase")
  const file = path.join(root, "archive.json")
  await writeFile(file, bytes)
  return JSON.stringify({ file, sha256: createHash("sha256").update(bytes).digest("hex"), id: value.id, workspaces })
}

const state: { output?: string } = {}
try {
  state.output = await prepare()
} catch {
  process.exitCode = 1
  process.stderr.write("Encrypted archive review fixture preparation failed.\n")
} finally {
  const { finish } = await import("../../../src/kilocode/cli/finish")
  await finish([], () => {
    if (state.output) process.stdout.write(state.output)
  })
}
