import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { link, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
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

async function removal(path: string): Promise<Request> {
  const info = await stat(path, { bigint: true })
  return {
    op: "removeFileChecked",
    path,
    identity: { dev: info.dev.toString(), ino: info.ino.toString() },
    sha256: hash(await readFile(path, "utf8")),
  }
}

async function anchored(file: string, root: string, data: string): Promise<Request> {
  const info = await stat(root, { bigint: true })
  return {
    op: "writeFileAnchored",
    path: file,
    data: Buffer.from(data).toString("base64"),
    root,
    identity: { dev: info.dev.toString(), ino: info.ino.toString() },
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

const holds = (root: string) => readdir(root).then((items) => items.filter((item) => item.includes(".raya-remove-")))

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

  test("creates nested content only beneath the reviewed ancestor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kilo-mutation-worker-"))
    roots.push(root)
    const file = path.join(root, "nested", "deep", "value.txt")

    expect(await worker(await anchored(file, root, "created"))).toEqual({ ok: true })
    expect(await readFile(file, "utf8")).toBe("created")
  })

  test("refuses an anchored create after the reviewed parent is replaced", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kilo-mutation-worker-"))
    roots.push(root)
    const parent = path.join(root, "reviewed")
    const moved = path.join(root, "moved")
    const file = path.join(parent, "nested", "value.txt")
    await mkdir(parent)
    const request = await anchored(file, parent, "private content")
    await rename(parent, moved)
    await mkdir(parent)

    const response = await worker(request)
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.error.code).toBe("ESTALE")
    expect(response.error.operation).toBe("writeFileAnchored")
    expect(await Bun.file(file).exists()).toBe(false)
    expect(await Bun.file(path.join(moved, "nested", "value.txt")).exists()).toBe(false)
  })

  test("removes only a file with the reviewed identity and content", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kilo-mutation-worker-"))
    roots.push(root)
    const file = path.join(root, "value.txt")
    await writeFile(file, "approved")

    expect(await worker(await removal(file))).toEqual({ ok: true })
    expect(await Bun.file(file).exists()).toBe(false)
    expect(await holds(root)).toEqual([])
  })

  test("restores a replacement file when checked removal detects a stale target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kilo-mutation-worker-"))
    roots.push(root)
    const file = path.join(root, "value.txt")
    const moved = path.join(root, "approved.txt")
    await writeFile(file, "approved")
    const request = await removal(file)
    await rename(file, moved)
    await writeFile(file, "replacement")

    const response = await worker(request)
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.error.code).toBe("ESTALE")
    expect(response.error.operation).toBe("removeFileChecked")
    expect(await readFile(file, "utf8")).toBe("replacement")
    expect(await readFile(moved, "utf8")).toBe("approved")
    expect(await holds(root)).toEqual([])
  })

  test("restores changed and hard-linked files refused by checked removal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kilo-mutation-worker-"))
    roots.push(root)
    {
      const file = path.join(root, "changed.txt")
      await writeFile(file, "approved")
      const request = await removal(file)
      await writeFile(file, "newer user content")
      const response = await worker(request)
      expect(response.ok).toBe(false)
      expect(await readFile(file, "utf8")).toBe("newer user content")
    }

    {
      const file = path.join(root, "linked.txt")
      const alias = path.join(root, "alias.txt")
      await writeFile(file, "approved")
      const request = await removal(file)
      await link(file, alias)
      const response = await worker(request)
      expect(response.ok).toBe(false)
      if (response.ok) return
      expect(response.error.message).toContain("Hard-linked files")
      expect(await readFile(file, "utf8")).toBe("approved")
      expect(await readFile(alias, "utf8")).toBe("approved")
    }
    expect(await holds(root)).toEqual([])
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
    const anchored = {
      op: "writeFileAnchored",
      path: "value.txt",
      data: "Y3JlYXRlZA==",
      root: ".",
      identity: { dev: "1", ino: "2" },
    }
    expect(isRequest(anchored)).toBe(true)
    expect(isRequest({ ...anchored, root: 1 })).toBe(false)
    expect(isRequest({ ...anchored, identity: { dev: "-1", ino: "2" } })).toBe(false)
    expect(isRequest({ op: "batch", operations: [anchored] })).toBe(false)
    const removal = {
      op: "removeFileChecked",
      path: "value.txt",
      identity: { dev: "1", ino: "2" },
      sha256: "a".repeat(64),
    }
    expect(isRequest(removal)).toBe(true)
    expect(isRequest({ ...removal, identity: { dev: "-1", ino: "2" } })).toBe(false)
    expect(isRequest({ op: "batch", operations: [removal] })).toBe(false)
  })
})
