import { test, expect } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { zstdDecompressSync } from "node:zlib"
import { Database } from "bun:sqlite"
import { Storage } from "../../src/kilocode/session-export/worker/storage"
import { Chunker } from "../../src/kilocode/session-export/worker/chunks"
import { evidence, exports } from "../../src/kilocode/migration/profile-exports"
import { locate } from "../../src/kilocode/migration/profile-data"

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "raya-export-evidence-"))
  const file = path.join(root, "session-export.db")
  const storage = new Storage(file)
  storage.migrate()
  const bytes = Buffer.from("Actual compressed export evidence — café 日本語 😀")
  const ids = await new Chunker(storage, { chunkBytes: 100_000 }).write(bytes)
  storage.insertEvent({
    id: crypto.randomUUID(),
    schemaVersion: 1,
    sessionId: "session-owned",
    rootSessionId: "session-owned",
    seq: 1,
    type: "tool_executed",
    ts: Date.now(),
    agentVersion: "private-fixture",
    clientScrubbed: 1,
    dataJson: JSON.stringify({ outputChunkIds: ids, text: "Preserve exact conversation evidence" }),
  })
  storage.close()
  return { root, file, bytes, ids }
}

test("real export SQLite and compressed chunks roundtrip as inert archive evidence", async () => {
  const source = await fixture()
  const before = createHash("sha256")
    .update(Buffer.from(await Bun.file(source.file).arrayBuffer()))
    .digest("hex")
  const value = await evidence(source.file)
  if (!value) throw new Error("Actual export fixture archive is absent")
  expect(value?.events).toHaveLength(1)
  expect(value?.chunks).toHaveLength(1)
  expect(value?.chunks[0].size).toBe(source.bytes.byteLength)
  expect(zstdDecompressSync(Buffer.from(value!.chunks[0].bytes, "base64"))).toEqual(source.bytes)
  const copy = exports.parse(JSON.parse(JSON.stringify(value)))
  expect(copy).toEqual(value)
  expect(copy.events[0].uploaded_at).toBeNull()
  expect(
    createHash("sha256")
      .update(Buffer.from(await Bun.file(source.file).arrayBuffer()))
      .digest("hex"),
  ).toBe(before)
  expect(await evidence(path.join(source.root, "missing.db"))).toBeUndefined()
  expect(await Bun.file(path.join(source.root, "missing.db")).exists()).toBe(false)
})

test("an overridden main SQLite location does not redirect shipped data-root export evidence", async () => {
  const source = await fixture()
  const storage = path.join(source.root, "storage")
  const separate = path.join(source.root, "external-sql")
  await mkdir(storage)
  await mkdir(separate)
  const file = path.join(separate, "override.db")
  const db = new Database(file)
  db.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('main database')")
  db.close()
  const before = createHash("sha256")
    .update(Buffer.from(await Bun.file(file).arrayBuffer()))
    .digest("hex")
  const selected = await locate(storage)
  expect(selected.exports).toBe(source.file)
  expect(selected.memory).toBe(path.join(source.root, "memory"))
  expect((await evidence(selected.exports))?.events).toHaveLength(1)
  expect(await evidence(path.join(path.dirname(file), "session-export.db"))).toBeUndefined()
  expect(
    createHash("sha256")
      .update(Buffer.from(await Bun.file(file).arrayBuffer()))
      .digest("hex"),
  ).toBe(before)
  expect((await locate(storage, separate)).data).toBe(separate)
})

test("corrupt chunks, absent references, unsanitized rows and changed native schema refuse", async () => {
  const source = await fixture()
  const value = await evidence(source.file)
  expect(exports.safeParse({ ...value, chunks: [] }).success).toBe(false)
  expect(
    exports.safeParse({ ...value, chunks: value!.chunks.map((row) => ({ ...row, id: "0".repeat(64) })) }).success,
  ).toBe(false)
  expect(exports.safeParse({ ...value, chunks: value!.chunks.map((row) => ({ ...row, bytes: "AAAA" })) }).success).toBe(
    false,
  )
  expect(
    exports.safeParse({ ...value, events: value!.events.map((row) => ({ ...row, client_scrubbed: 0 })) }).success,
  ).toBe(false)
  expect(exports.safeParse({ ...value, events: [...value!.events, ...value!.events] }).success).toBe(false)
  expect(
    exports.safeParse({ ...value, events: value!.events.map((row) => ({ ...row, data_json: "{" })) }).success,
  ).toBe(false)
  expect(exports.safeParse({ ...value, chunks: value!.chunks.map((row) => ({ ...row, size: 1 })) }).success).toBe(false)
  const db = new Database(source.file)
  db.exec("ALTER TABLE event ADD COLUMN unexpected TEXT")
  db.close()
  const failure = await evidence(source.file).then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(failure).toBeInstanceOf(Error)
  if (!(failure instanceof Error)) throw new Error("Expected native schema refusal")
  expect(failure.message).toBe("Unsupported session export schema")
})

test("actual encrypted two-hop restore preserves archive without an active uploader database", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "raya-export-restore-"))
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) if (/^(?:OTEL_|KILO_|RAYA_)|(?:API_KEY|TOKEN|SECRET)$/.test(key)) delete env[key]
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    KILO_TEST_HOME: root,
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    RAYA_DB: path.join(root, "unused.db"),
    KILO_DB: path.join(root, "unused.db"),
    RAYA_AUTH_CONTENT: "{}",
    KILO_AUTH_CONTENT: "{}",
    KILO_DISABLE_MODELS_FETCH: "1",
    KILO_PURE: "1",
  })
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/profile-exports-restore.ts"), root], {
    env,
    windowsHide: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = [new Response(child.stdout).text(), new Response(child.stderr).text()]
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, ...output])
    await Bun.write(path.join(root, "stdout.log"), stdout)
    await Bun.write(path.join(root, "stderr.log"), stderr)
    expect(code, `Private diagnostics retained at ${root}: ${stderr}`).toBe(0)
    expect(JSON.parse(stdout.trim())).toEqual({
      ok: true,
      hops: 2,
      artifactHistoryPreserved: true,
      activeUploaderDatabaseAbsent: true,
      portable: false,
    })
    expect(() => process.kill(child.pid, 0)).toThrow()
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
    await Promise.all(output)
  }
}, 65_000)
