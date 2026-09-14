import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { link, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isRequest, isResponse, type Request } from "../src/mutation-protocol"

const roots: string[] = []

const hash = (data: string) => createHash("sha256").update(data).digest("hex")

async function checked(path: string, data: string): Promise<Request> {
  const info = await stat(path, { bigint: true })
  return {
    op: "writeFileChecked",
    path,
    data: Buffer.from(data).toString("base64"),
    identity: { dev: info.dev.toString(), ino: info.ino.toString() },
    sha256: hash(await readFile(path, "utf8")),
  }
}

async function worker(request: Request) {
  const entry = fileURLToPath(new URL("../src/kilo-sandbox-mutation-worker.ts", import.meta.url))
  const proc = Bun.spawn([process.execPath, entry], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  await proc.stdin.write(JSON.stringify(request))
  await proc.stdin.end()
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(stderr || `Filesystem worker exited ${code}`)
  const response: unknown = JSON.parse(stdout)
  if (!isResponse(response)) throw new Error("Filesystem worker returned an invalid response")
  return response
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("filesystem mutation worker", () => {
  test("executes ordered mutation batches", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kilo-mutation-worker-"))
    roots.push(root)
    const dir = path.join(root, "nested")
    const file = path.join(dir, "value.txt")
    const response = await worker({
      op: "batch",
      operations: [
        { op: "makeDirectory", path: dir, options: { recursive: true } },
        { op: "writeFileString", path: file, data: "batched" },
        { op: "chmod", path: file, mode: 0o640 },
      ],
    })

    expect(response).toEqual({ ok: true })
    expect(await readFile(file, "utf8")).toBe("batched")
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o640)
  })

  test("serializes single-operation filesystem failures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kilo-mutation-worker-"))
    roots.push(root)
    const response = await worker({ op: "writeFileString", path: path.join(root, "missing", "value.txt"), data: "x" })

    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.error.message).toContain("no such file or directory")
    expect(response.error.operation).toBe("writeFileString")
    expect(response.error.code).toBe("ENOENT")
  })

  test("reports the failed operation and stops the remaining batch", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kilo-mutation-worker-"))
    roots.push(root)
    const missing = path.join(root, "missing", "value.txt")
    const skipped = path.join(root, "skipped.txt")
    const response = await worker({
      op: "batch",
      operations: [
        { op: "writeFileString", path: missing, data: "blocked" },
        { op: "writeFileString", path: skipped, data: "skipped" },
      ],
    })

    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.error.operation).toBe("writeFileString")
    expect(response.error.code).toBe("ENOENT")
    expect(await Bun.file(skipped).exists()).toBe(false)
  })

  test("writes through the same file handle after identity and content validation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kilo-mutation-worker-"))
    roots.push(root)
    const file = path.join(root, "value.txt")
    await writeFile(file, "approved")
    const request = await checked(file, "changed")

    expect(await worker(request)).toEqual({ ok: true })
    expect(await readFile(file, "utf8")).toBe("changed")
  })

  test("creates a missing file exclusively", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kilo-mutation-worker-"))
    roots.push(root)
    const file = path.join(root, "value.txt")
    const request = {
      op: "writeFileExclusive" as const,
      path: file,
      data: Buffer.from("created").toString("base64"),
    }

    expect(await worker(request)).toEqual({ ok: true })
    expect(await readFile(file, "utf8")).toBe("created")
  })

  test("refuses an exclusive create when another writer already owns the pathname", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kilo-mutation-worker-"))
    roots.push(root)
    const file = path.join(root, "value.txt")
    await writeFile(file, "user content")
    const response = await worker({
      op: "writeFileExclusive",
      path: file,
      data: Buffer.from("agent content").toString("base64"),
    })

    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.error.code).toBe("EEXIST")
    expect(response.error.operation).toBe("writeFileExclusive")
    expect(await readFile(file, "utf8")).toBe("user content")
  })

  test("refuses a pathname replaced after approval without changing either file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kilo-mutation-worker-"))
    roots.push(root)
    const file = path.join(root, "value.txt")
    const moved = path.join(root, "approved.txt")
    await writeFile(file, "approved")
    const request = await checked(file, "changed")
    await rename(file, moved)
    await writeFile(file, "replacement")

    const response = await worker(request)
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.error.code).toBe("ESTALE")
    expect(response.error.operation).toBe("writeFileChecked")
    expect(await readFile(file, "utf8")).toBe("replacement")
    expect(await readFile(moved, "utf8")).toBe("approved")
  })

  test("refuses changed content on the approved file without overwriting it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kilo-mutation-worker-"))
    roots.push(root)
    const file = path.join(root, "value.txt")
    await writeFile(file, "approved")
    const request = await checked(file, "agent change")
    await writeFile(file, "newer user change")

    const response = await worker(request)
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.error.code).toBe("ESTALE")
    expect(await readFile(file, "utf8")).toBe("newer user change")
  })

  test("refuses hard-linked files without changing either name", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kilo-mutation-worker-"))
    roots.push(root)
    const file = path.join(root, "value.txt")
    const alias = path.join(root, "alias.txt")
    await writeFile(file, "approved")
    await link(file, alias)
    const request = await checked(file, "agent change")

    const response = await worker(request)
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.error.code).toBe("ESTALE")
    expect(response.error.message).toContain("Hard-linked files")
    expect(await readFile(file, "utf8")).toBe("approved")
    expect(await readFile(alias, "utf8")).toBe("approved")
  })

  test("rejects malformed checked writes and immediate writes inside batches", () => {
    const base = {
      op: "writeFileChecked",
      path: "value.txt",
      data: "Y2hhbmdlZA==",
      identity: { dev: "1", ino: "2" },
      sha256: "a".repeat(64),
    }
    expect(isRequest(base)).toBe(true)
    expect(isRequest({ ...base, identity: { dev: "-1", ino: "2" } })).toBe(false)
    expect(isRequest({ ...base, identity: { dev: "1.5", ino: "2" } })).toBe(false)
    expect(isRequest({ ...base, sha256: "not-a-hash" })).toBe(false)
    expect(isRequest({ op: "batch", operations: [base] })).toBe(false)
    const exclusive = { op: "writeFileExclusive", path: "value.txt", data: "Y3JlYXRlZA==" }
    expect(isRequest(exclusive)).toBe(true)
    expect(isRequest({ op: "batch", operations: [exclusive] })).toBe(false)
  })
})
