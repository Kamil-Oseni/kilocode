import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepare, score, serve } from "./computer-use-browser-entry-task"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "raya-browser-entry-test-"))
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
  return { dir, ext, root }
}

async function submitted(root: string) {
  const { server, url } = await serve(root)
  const page = await fetch(url)
  expect(page.status).toBe(200)
  expect(await page.text()).toContain("Allocation notes")
  const seed = (JSON.parse(await readFile(join(root, "task.json"), "utf8")) as { seed: number }).seed
  const rows = ["Aster", "Birch", "Cedar"].map((name, index) => ({
    name,
    region: ["North", "East", "West"][index],
    units: seed + index * 7,
  }))
  const submit = async (value: unknown) =>
    fetch(new URL("/submit", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    })
  return { server, url, rows, submit }
}

describe("installed browser research and entry scorer", () => {
  test("setup alone cannot pass and a single exact submission can", async () => {
    const item = await fixture()
    await prepare(item.root, item.ext)
    expect(await score(item.root)).toMatchObject({ correctFinalState: false, releaseGateEligible: false })
    const app = await submitted(item.root)
    try {
      expect((await app.submit({ rows: app.rows })).status).toBe(201)
      expect(await score(item.root)).toMatchObject({ correctFinalState: true, submissions: 1, replay: false })
    } finally {
      app.server.stop(true)
    }
  })

  test("rejects wrong and extra data, then detects replay", async () => {
    const item = await fixture()
    await prepare(item.root, item.ext)
    const app = await submitted(item.root)
    try {
      await app.submit({ rows: app.rows.map((row, index) => (index === 1 ? { ...row, units: row.units + 1 } : row)) })
      expect(await score(item.root)).toMatchObject({ correctFinalState: false, changed: ["submissions.jsonl"] })
      await app.submit({ rows: app.rows })
      expect(await score(item.root)).toMatchObject({ correctFinalState: false, submissions: 2, replay: true })
    } finally {
      app.server.stop(true)
    }
  })

  test("detects modified source, extra files, and malformed submissions", async () => {
    const item = await fixture()
    await prepare(item.root, item.ext)
    await writeFile(join(item.root, "source.html"), "modified")
    await writeFile(join(item.root, "extra.txt"), "extra")
    await writeFile(join(item.root, "submissions.jsonl"), "invalid\n")
    expect(await score(item.root)).toMatchObject({
      correctFinalState: false,
      changed: ["source.html", "submissions.jsonl"],
      unexpected: ["extra.txt"],
    })
    expect(serve(item.root)).rejects.toThrow("Modified source page")
  })

  test("refuses cross-origin and oversized requests without recording a submission", async () => {
    const item = await fixture()
    await prepare(item.root, item.ext)
    const app = await submitted(item.root)
    try {
      const target = new URL("/submit", app.url)
      const blocked = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://unrelated.example" },
        body: JSON.stringify({ rows: app.rows }),
      })
      expect(blocked.status).toBe(403)
      const oversized = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows: app.rows, padding: "x".repeat(17_000) }),
      })
      expect(oversized.status).toBe(413)
      expect(await score(item.root)).toMatchObject({ correctFinalState: false, submissions: 0 })
    } finally {
      app.server.stop(true)
    }
  })

  test("refuses to overwrite an existing task directory", async () => {
    const item = await fixture()
    await mkdir(item.root)
    await writeFile(join(item.root, "keep.txt"), "keep")
    expect(prepare(item.root, item.ext)).rejects.toThrow("empty disposable task directory")
    expect(await readFile(join(item.root, "keep.txt"), "utf8")).toBe("keep")
  })
})
