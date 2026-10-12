import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { lstat, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { BrainSettings } from "../../../src/second-brain/settings"
import { BrainService } from "../../../src/second-brain/service"
import { release } from "../../../src/second-brain/control/catalog-v2"

const [mode, root, origin] = process.argv.slice(2)
// Records production-valid synthetic metadata; no native proposal is dispatched.
const file = path.join(root, "state.json")
const secrets: string[] = []
const writes: string[] = []
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const settings = new BrainSettings(
  {
    get<T>(key: string) {
      return JSON.parse(readFileSync(file, "utf8"))[key] as T | undefined
    },
    async update(key, value) {
      writes.push(key)
      if (mode !== "writer") throw new Error("Cold reader must not change original state")
      const row = JSON.parse(await readFile(file, "utf8"))
      row[key] = value
      await writeFile(file, JSON.stringify(row))
    },
  },
  {
    async get(key) {
      secrets.push(key)
      throw new Error("Cold reader must not obtain credentials")
    },
    async store(key) {
      secrets.push(key)
      if (mode !== "writer") throw new Error("Cold reader must not store credentials")
    },
    async delete(key) {
      secrets.push(key)
      throw new Error("Cold reader must not remove credentials")
    },
  },
)

if (mode === "writer") {
  const helper = path.resolve(import.meta.dir, "../../../bin/raya-process-host.exe")
  const child = Bun.spawn([helper, "inspect", String(process.pid)], {
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  assert.equal(code, 0, err)
  const native = JSON.parse(out)
  assert.equal(native.status, "owned")
  const tuple = async (dir: string) => {
    const row = await lstat(dir, { bigint: true })
    assert.ok(row.isDirectory() && !row.isSymbolicLink())
    return [String(row.dev), String(row.ino), null]
  }
  const body = {
    id: randomUUID(),
    proposal_digest: "a".repeat(64),
    expected_policy_sha256: "b".repeat(64),
  }
  const bytes = Buffer.from(JSON.stringify(body))
  const debt = {
    format: "raya.memory.control.uncertainty",
    version: 1,
    root,
    request: {
      op: "manual_proposal_publish",
      seq: 1,
      bytes: bytes.length,
      digest: digest(bytes),
      identity: {
        pid: process.pid,
        birth: native.birth,
        parent: native.parent,
        executable: process.execPath,
        digest: digest(await readFile(process.execPath)),
      },
      mutation: {
        expected: body.expected_policy_sha256,
        proposal: body.id,
        proposal_digest: body.proposal_digest,
        namespace: { root: await tuple(root), system: await tuple(path.join(root, "System")) },
      },
    },
  }
  await settings.save(
    {
      format: "raya.memory.setup",
      version: 2,
      protocol: "raya.memory.operation.v1",
      origin,
      root,
      source_sha256: release,
    },
    "synthetic-only",
  )
  await settings.record(debt)
  assert.deepEqual(settings.pending(), debt)
  console.log(JSON.stringify({ pid: process.pid, debt, sha256: digest(await readFile(file)), nativeDispatch: false }))
}

if (mode === "reader") {
  const before = await readFile(file)
  const debt = settings.pending()
  assert.ok(debt)
  const request = debt.request
  assert.ok(request && typeof request === "object" && "mutation" in request)
  const mutation = request.mutation
  assert.ok(mutation && typeof mutation === "object" && "proposal" in mutation)
  assert.equal(typeof mutation.proposal, "string")
  const service = new BrainService(settings)
  const status = await service.status()
  assert.deepEqual(status, { configured: true, status: "unavailable", code: "control_uncertain", results: [] })
  await assert.rejects(
    service.management(
      { action: "read", project: root, id: mutation.proposal },
      new AbortController().signal,
      () => undefined,
    ),
    /pending original settlement/,
  )
  await assert.rejects(
    service.run("No cold search", () => assert.fail("No result publication")),
    /reconciliation/,
  )
  await assert.rejects(
    service.configure(() =>
      service.sync("b".repeat(64), new AbortController().signal, async () => assert.fail("No cold native close")),
    ),
    /pending original settlement/,
  )
  await service.dispose()
  assert.deepEqual(settings.pending(), debt)
  assert.deepEqual(await readFile(file), before)
  assert.deepEqual(secrets, [])
  assert.deepEqual(writes, [])
  console.log(JSON.stringify({ pid: process.pid, debt, sha256: digest(before), status, secrets, writes }))
}
