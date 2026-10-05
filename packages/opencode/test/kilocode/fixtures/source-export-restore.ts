import assert from "node:assert/strict"
import { ReviewSchema } from "../../../src/kilocode/migration/profile-restore-review-schema"
import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import z from "zod"
import { unseal } from "../../../src/kilocode/migration/profile-bundle"
import { restore } from "../../../src/kilocode/migration/profile-restore"
import { identity } from "../../../src/kilocode/migration/profile-workspaces"
import { finish } from "../../../src/kilocode/cli/finish"

const state = { stage: "input", checks: 0 }
const confidential: { password?: string } = {}
const [file, directory] = process.argv.slice(2)
if (!file || !directory || !path.isAbsolute(file) || !path.isAbsolute(directory))
  throw new Error("Restore fixture requires encrypted path and private destination base")
const base = await realpath(directory)
if (base !== directory || !(await lstat(base)).isDirectory()) throw new Error("Restore fixture base must be physical")
const receipt = path.join(base, "source-export-restore-receipt.json")
const check = (value: unknown, expected: unknown) => {
  assert.deepEqual(value, expected)
  state.checks++
}
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex")
async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-c", "core.fsmonitor=false", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_"))),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(base, "absent-git-config"),
      GIT_TERMINAL_PROMPT: "0",
    },
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  assert.equal(code, 0, `Private restored Git command refused: ${stderr.slice(0, 512)}`)
  return stdout
}
try {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > 4096) throw new Error("Restore fixture private stdin exceeded bound")
    chunks.push(bytes)
  }
  const secret = z
    .object({ password: z.string().min(12).max(1024), secondHop: z.boolean().optional() })
    .strict()
    .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")))
  confidential.password = secret.password
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 180 * 1024 * 1024)
    throw new Error("Restore fixture encrypted input is not bounded unique file")
  const text = await readFile(file, "utf8")
  const original = await unseal(text, secret.password)
  state.stage = "mapping"
  const target = path.join(base, "restored-profile")
  const mappings: Record<string, string> = {}
  const mapped = (source: string) =>
    Object.entries(mappings).find(([value]) => identity(value) === identity(source))?.[1]
  const primaries: string[] = []
  for (const [index, source] of original.workspaces.entries()) {
    const managed = original.artifacts?.worktrees.find((tree) => identity(tree.workspace) === identity(source))
    if (managed) {
      mappings[source] = path.join(target, "data", "kilo", "worktree", managed.project, managed.name)
      continue
    }
    const destination = path.join(base, "workspaces", String(index))
    await mkdir(destination, { recursive: true })
    mappings[source] = await realpath(destination)
    if (
      original.artifacts?.repositories.some((repo) => repo.workspace && identity(repo.workspace) === identity(source))
    )
      primaries.push(source)
  }
  state.stage = "restore"
  const restored = await restore(text, secret.password, target, mappings, { primaries })
  const counters = (await import("./source-sql-allocator-assert")).assertAllocatorSource(original)
  const metadata = JSON.parse(await readFile(path.join(restored.path, "restore-sql-metadata.json"), "utf8"))
  check(metadata.format, "raya.inactive-profile-sqlite-allocators")
  check(metadata.installation, false)
  check(metadata.entries.length, 1)
  check(metadata.entries[0].allocator.rows, counters.rows)
  const allocator = new Database(path.join(restored.path, "raya.db"), { readonly: true, strict: true })
  try {
    check(allocator.query("SELECT name,seq FROM sqlite_sequence").all(), [])
  } finally {
    allocator.close()
  }
  if (original.operational) {
    check(
      JSON.parse(await readFile(path.join(restored.path, "restore-operational.json"), "utf8")),
      original.operational,
    )
    state.checks++
  }
  if (original.composers) {
    state.stage = "inactive-composers"
    await (await import("./composer-restored")).verifyComposers(restored.path, original.composers, mappings)
    state.checks++
  }
  if (original.voice) {
    state.stage = "inactive-voice"
    await (await import("./source-voice-reconciliation-assert")).verifyVoiceRestored(restored.path, original.voice)
    state.checks++
  }
  if (original.memory.length) {
    state.stage = "inactive-memory"
    await (await import("./memory-restored")).verify(restored.path, original.memory)
    state.checks++
  }
  if (original.disposition) {
    check(
      JSON.parse(await readFile(path.join(restored.path, "restore-disposition.json"), "utf8")),
      original.disposition,
    )
    const retained = JSON.parse(await readFile(path.join(restored.path, "restore-source.json"), "utf8"))
    check(retained.disposition, original.disposition)
    check(retained.sql, original.sql)
  }
  if (original.config) {
    state.stage = "inactive-config"
    const content = await readFile(path.join(restored.path, "restore-config.json"), "utf8")
    check(JSON.parse(content), original.config)
    check(content.includes("SYNTHETIC_CONFIG_SENTINEL"), false)
    check(original.config.activation, "held")
    check(original.config.reviewOnly, true)
    for (const name of ["kilo.json", "kilo.jsonc", "explicit.json"]) {
      check(await Bun.file(path.join(restored.env.XDG_CONFIG_HOME, "kilo", name)).exists(), false)
      check(await Bun.file(path.join(restored.env.XDG_CONFIG_HOME, name)).exists(), false)
    }
  }
  const absent = original.stores?.filter((store) => store.kind === "absent") ?? []
  if (absent.length) {
    const lineage = z
      .object({
        format: z.literal("raya.inactive-profile-stores"),
        version: z.literal(1),
        activation: z.literal("held"),
        stores: z.array(z.object({ kind: z.string() }).passthrough()),
      })
      .strict()
      .parse(JSON.parse(await readFile(path.join(restored.path, "restore-stores.json"), "utf8")))
    check(
      lineage.stores.filter((store) => store.kind === "absent"),
      absent,
    )
    for (const store of absent) {
      check(await Bun.file(path.join(restored.path, path.basename(store.source))).exists(), false)
      check(await Bun.file(path.join(restored.path, "data", "kilo", path.basename(store.source))).exists(), false)
    }
  }
  state.stage = "inactive-storage"
  state.checks += await (await import("./storage-restored")).verifyStorage(original.json, restored.path)
  state.stage = "database"
  const sessions = original.sql.find((table) => table.table === "session")
  assert(sessions && sessions.rows.length > 0, "Actual source durable session evidence required")
  const db = new Database(path.join(restored.path, "raya.db"), { readonly: true })
  try {
    for (const row of sessions.rows) {
      const id = row[sessions.columns.indexOf("id")]
      assert(typeof id === "string")
      const actual = db
        .query<{ id: string; title: string }, [string]>("SELECT id,title FROM session WHERE id=?")
        .get(id)
      check(actual?.id, id)
      check(actual?.title, row[sessions.columns.indexOf("title")])
    }
    check(db.query<{ count: number }, []>("SELECT count(*) AS count FROM session_input").get()?.count, 0)
    const semantic = original.disposition?.files.find(
      (entry) => entry.disposition.kind === "sqlite-semantic" && entry.disposition.component === "sql",
    )?.disposition
    if (semantic?.kind === "sqlite-semantic" && semantic.journal) {
      const installed = db
        .query<{ id: string; time_completed: number }, []>("SELECT id,time_completed FROM migration")
        .all()
      check(installed.length, semantic.journal.rows.length)
      check(
        semantic.journal.rows.every((entry) => installed.some((row) => row.id === entry.id)),
        true,
      )
      check(
        semantic.journal.rows.some((entry) =>
          installed.some((row) => row.id === entry.id && row.time_completed !== entry.time_completed),
        ),
        true,
      )
      check(semantic.journal.reconstruction, false)
    }
    const contacts = original.sql.find((table) => table.table === "raya_contact_destination")
    if (contacts?.rows.some((row) => row[contacts.columns.indexOf("id")] === "private-correspondence-contact")) {
      check(
        contacts.rows.find((row) => row[contacts.columns.indexOf("id")] === "private-correspondence-contact")?.[
          contacts.columns.indexOf("enabled")
        ],
        1,
      )
      check(
        db
          .query<
            { enabled: number },
            []
          >("SELECT enabled FROM raya_contact_destination WHERE id='private-correspondence-contact'")
          .get()?.enabled,
        0,
      )
    }
  } finally {
    db.close()
  }
  state.stage = "hold"
  const review = ReviewSchema.parse(JSON.parse(await readFile(path.join(restored.path, "restore-review.json"), "utf8")))
  const hold = z
    .object({ id: z.string().uuid(), state: z.string() })
    .passthrough()
    .parse(JSON.parse(await readFile(path.join(restored.path, "storage/raya/restore-hold.json"), "utf8")))
  check(restored.reviewed, false)
  check(restored.reconnectCredentials, true)
  check(restored.uncertainWork, "held-no-replay")
  check(review.reconnectCredentials, true)
  check(review.uncertainWork, "held-no-replay")
  check(hold.state, "held")
  check(hold.id, restored.hold)
  if (original.host)
    check(JSON.parse(await readFile(path.join(restored.path, "restore-host.json"), "utf8")), original.host)
  state.stage = "git"
  const trees: { files: number; index: string | null; status: string; worktrees: boolean }[] = []
  for (const tree of original.artifacts?.worktrees ?? []) {
    const workspace = mapped(tree.workspace)
    assert(workspace, "Captured worktree requires explicit normalized destination mapping")
    for (const entry of tree.files)
      check(await readFile(path.join(workspace, ...entry.path.split("/"))), Buffer.from(entry.bytes, "base64"))
    const pointer = await readFile(path.join(workspace, ".git"), "utf8")
    assert(pointer.startsWith("gitdir: "))
    const admin = path.resolve(workspace, pointer.slice(8).trim())
    const index = tree.admin.find((entry) => entry.path === "index")
    if (index) check(await readFile(path.join(admin, "index")), Buffer.from(index.bytes, "base64"))
    const status = await git(workspace, "status", "--porcelain=v1", "-z")
    const listed = await git(workspace, "ls-files", "--stage", "-z")
    assert(listed.length > 0, "Restored managed Git index must be usable")
    const worktrees = await git(workspace, "worktree", "list", "--porcelain")
    const paths = worktrees
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => identity(line.slice(9)))
    check(paths.includes(identity(workspace)), true)
    const primary = original.artifacts?.repositories.find((repo) => repo.id === tree.common)?.workspace
    if (primary && primaries.some((source) => identity(source) === identity(primary))) {
      const destination = mapped(primary)
      assert(destination, "Captured primary requires explicit normalized destination mapping")
      check(paths.includes(identity(destination)), true)
    }
    if (tree.files.some((entry) => entry.path === "actual.txt")) {
      check(status.includes("actual.txt"), true)
      check((await git(workspace, "diff", "--", "actual.txt")).length > 0, true)
    }
    if (tree.files.some((entry) => entry.path === "untracked.txt")) check(status.includes("?? untracked.txt"), true)
    trees.push({
      files: tree.files.length,
      index: index ? hash(Buffer.from(index.bytes, "base64")) : null,
      status: hash(status),
      worktrees: true,
    })
  }
  state.stage = "complete"
  const result = {
    format: "raya.source-export-restore-fixture",
    version: 1,
    passed: true,
    checks: state.checks,
    path: restored.path,
    sessions: sessions.rows.length,
    host: !!original.host,
    held: true,
    reconnect: true,
    noReplay: true,
    trees,
    secondExportAttempted: secret.secondHop === true,
    ...(secret.secondHop && original.config
      ? {
          secondHop: await (
            await import("./source-config-second-hop")
          ).roundtrip(
            original.config,
            restored,
            base,
            secret.password,
            original.disposition,
            original.memory,
            original.json,
            original.voice,
            original.composers,
            original.operational,
            original,
          ),
        }
      : {}),
    completeProfileCoverage: false,
    portableCaptureAuthorized: false,
    finishRequested: true,
  }
  await writeFile(receipt, JSON.stringify(result), { flag: "wx", mode: 0o600 })
  process.stdout.write(`SOURCE_EXPORT_RESTORE_RECEIPT ${JSON.stringify(result)}\n`)
} catch (err) {
  process.exitCode = 1
  const message =
    confidential.password && err instanceof Error
      ? err.message.split(confidential.password).join("[redacted]").slice(0, 2048)
      : "Private restore fixture input refused"
  await writeFile(
    receipt,
    JSON.stringify({
      format: "raya.source-export-restore-fixture",
      version: 1,
      passed: false,
      stage: state.stage,
      checks: state.checks,
      reason: message,
      portableCaptureAuthorized: false,
    }),
    { flag: "wx", mode: 0o600 },
  )
  process.stderr.write(`Private source export restore refused at ${state.stage}; receipt retained\n`)
} finally {
  await finish([])
}
