import { afterEach, describe, expect, test } from "bun:test"
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepare, score, serve } from "./computer-use-scroll-task"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "raya-scroll-task-test-"))
  dirs.push(dir)
  const ext = join(dir, "extension")
  const root = join(dir, "task")
  await mkdir(join(ext, "bin"), { recursive: true })
  await writeFile(
    join(ext, "package.json"),
    JSON.stringify({ publisher: "eden", name: "raya", version: "7.4.23-snapshot+test" }),
  )
  await writeFile(join(ext, "bin", "raya-desktop-capture.exe"), "capture bytes")
  await writeFile(join(ext, "bin", "raya-desktop-input.exe"), "input bytes")
  return { ext, root }
}

async function submit(url: string, body: unknown) {
  return fetch(new URL("select", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("installed long-scrolling task scorer", () => {
  test("requires a far-below-fold target and a single persisted selection", async () => {
    const item = await fixture()
    const task = await prepare(item.root, item.ext)
    const html = await readFile(join(item.root, "records.html"), "utf8")
    expect(task.manifest.scenario).toBe("long-scrolling")
    expect(task.manifest.target).toBeGreaterThanOrEqual(55)
    expect(html).toContain('data-record="72"')
    expect((await score(item.root)).correctFinalState).toBe(false)
    expect((await score(item.root)).releaseGateEligible).toBe(false)
    const app = await serve(item.root)
    try {
      expect((await fetch(app.url)).status).toBe(200)
      expect((await submit(app.url, { record: task.manifest.target, token: task.manifest.token })).status).toBe(201)
      expect(await score(item.root)).toMatchObject({ correctFinalState: true, selections: 1, replay: false })
    } finally {
      app.server.stop(true)
    }
  })

  test("detects duplicate native effects rather than treating the last selection as success", async () => {
    const item = await fixture()
    const task = await prepare(item.root, item.ext)
    const app = await serve(item.root)
    try {
      const body = { record: task.manifest.target, token: task.manifest.token }
      await submit(app.url, body)
      await submit(app.url, body)
      expect(await score(item.root)).toMatchObject({ correctFinalState: false, selections: 2, replay: true })
    } finally {
      app.server.stop(true)
    }
  })

  test("detects a wrong record, altered page, and extra files", async () => {
    const item = await fixture()
    const task = await prepare(item.root, item.ext)
    const app = await serve(item.root)
    try {
      await submit(app.url, { record: task.manifest.target - 1, token: task.manifest.token })
    } finally {
      app.server.stop(true)
    }
    expect((await score(item.root)).changed).toContain("selections.jsonl")
    await writeFile(join(item.root, "records.html"), "modified")
    await writeFile(join(item.root, "extra.txt"), "extra")
    expect(await score(item.root)).toMatchObject({ correctFinalState: false, unexpected: ["extra.txt"] })
    expect((await score(item.root)).changed).toContain("records.html")
  })

  test("rejects malformed or forged selection log", async () => {
    const item = await fixture()
    const task = await prepare(item.root, item.ext)
    await writeFile(join(item.root, "selections.jsonl"), "not json\n")
    expect((await score(item.root)).changed).toContain("selections.jsonl")
    await writeFile(
      join(item.root, "selections.jsonl"),
      JSON.stringify({ record: task.manifest.target, token: "wrong" }),
    )
    expect((await score(item.root)).changed).toContain("selections.jsonl")
    await appendFile(join(item.root, "selections.jsonl"), "\n")
    expect((await score(item.root)).correctFinalState).toBe(false)
  })

  test("rejects a modified manifest and nonempty destination", async () => {
    const item = await fixture()
    await mkdir(item.root)
    await writeFile(join(item.root, "keep.txt"), "keep")
    expect(prepare(item.root, item.ext)).rejects.toThrow("empty disposable task directory")
    await rm(item.root, { recursive: true })
    await prepare(item.root, item.ext)
    const path = join(item.root, "task.json")
    const data = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    data.target = 1
    await writeFile(path, JSON.stringify(data))
    expect(score(item.root)).rejects.toThrow("Invalid or modified task manifest")
  })

  test("server refuses cross-origin and oversized submissions without recording them", async () => {
    const item = await fixture()
    await prepare(item.root, item.ext)
    const app = await serve(item.root)
    try {
      const url = new URL("select", app.url)
      expect(
        (
          await fetch(url, {
            method: "POST",
            headers: { origin: "https://other.test", "content-type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(403)
      expect((await submit(app.url, { data: "x".repeat(2000) })).status).toBe(413)
      expect((await score(item.root)).missing).toContain("selections.jsonl")
    } finally {
      app.server.stop(true)
    }
  })
})
