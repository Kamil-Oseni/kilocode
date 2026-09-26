import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepare, score, serve } from "./computer-use-popup-task"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "raya-popup-test-"))
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
  await prepare(root, ext)
  const input = JSON.parse(await readFile(join(root, "task.json"), "utf8")) as { runId: string; seed: number }
  return { root, input }
}

async function app(root: string, runId: string) {
  const { server, url } = await serve(root)
  const post = (kind: string, values?: unknown, headers?: Record<string, string>) =>
    fetch(new URL(`/${kind}`, url), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ runId, ...(values === undefined ? {} : { values }) }),
    })
  return { server, url, post }
}

describe("installed unexpected popup recovery task", () => {
  test("setup alone fails; popup, dismissal, and one exact submission pass", async () => {
    const item = await fixture()
    expect(await score(item.root)).toMatchObject({ correctFinalState: false, releaseGateEligible: false })
    const site = await app(item.root, item.input.runId)
    try {
      const response = await fetch(site.url)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain("Quick check")
      expect((await site.post("shown")).status).toBe(201)
      expect((await site.post("dismiss")).status).toBe(201)
      expect(
        (await site.post("submit", { Project: `North-${item.input.seed}`, Owner: "Raya", Decision: "Review" })).status,
      ).toBe(201)
      expect(await score(item.root)).toMatchObject({
        correctFinalState: true,
        popupRecovered: true,
        submissions: 1,
        replay: false,
        releaseGateEligible: false,
      })
    } finally {
      site.server.stop(true)
    }
  })

  test("submission before popup or dismissal is refused, and repeat submission cannot pass", async () => {
    const item = await fixture()
    const site = await app(item.root, item.input.runId)
    const values = { Project: `North-${item.input.seed}`, Owner: "Raya", Decision: "Review" }
    try {
      expect((await site.post("submit", values)).status).toBe(409)
      expect((await site.post("dismiss")).status).toBe(409)
      expect((await site.post("shown")).status).toBe(201)
      expect((await site.post("submit", values)).status).toBe(409)
      expect((await site.post("dismiss")).status).toBe(201)
      expect((await site.post("submit", values)).status).toBe(201)
      expect((await site.post("submit", values)).status).toBe(409)
      expect(await score(item.root)).toMatchObject({ correctFinalState: true, submissions: 1 })
    } finally {
      site.server.stop(true)
    }
  })

  test("wrong values, forged order, duplicate event, and malformed event fail independently", async () => {
    const item = await fixture()
    const site = await app(item.root, item.input.runId)
    try {
      await site.post("shown")
      await site.post("dismiss")
      await site.post("submit", { Project: `North-${item.input.seed}`, Owner: "Other", Decision: "Review" })
      expect(await score(item.root)).toMatchObject({ correctFinalState: false, popupRecovered: true })
    } finally {
      site.server.stop(true)
    }
    const path = join(item.root, "events.jsonl")
    const data = await readFile(path, "utf8")
    await writeFile(path, `${data}${data.split("\n")[2]}\n`)
    expect(await score(item.root)).toMatchObject({ correctFinalState: false, submissions: 2, replay: true })
    await writeFile(path, data.replace('"kind":"dismiss"', '"kind":"shown"'))
    expect(await score(item.root)).toMatchObject({ correctFinalState: false, popupRecovered: false })
    await writeFile(path, "invalid\n")
    expect(await score(item.root)).toMatchObject({ correctFinalState: false, changed: ["events.jsonl"] })
  })

  test("modified page, extra file, wrong run, cross-origin and oversized events fail", async () => {
    const item = await fixture()
    const site = await app(item.root, item.input.runId)
    try {
      expect((await site.post("shown", undefined, { origin: "https://unrelated.example" })).status).toBe(403)
      expect((await site.post("shown", "x".repeat(5000))).status).toBe(413)
      expect((await site.post("shown", undefined, { "content-type": "text/plain" })).status).toBe(415)
      const wrong = await fetch(new URL("/shown", site.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: "wrong" }),
      })
      expect(wrong.status).toBe(403)
      const forged = await fetch(new URL("/shown", site.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: item.input.runId, kind: "submit" }),
      })
      expect(forged.status).toBe(400)
    } finally {
      site.server.stop(true)
    }
    await writeFile(join(item.root, "page.html"), "changed")
    await writeFile(join(item.root, "extra.txt"), "extra")
    expect(await score(item.root)).toMatchObject({
      correctFinalState: false,
      changed: ["page.html"],
      unexpected: ["extra.txt"],
    })
    expect(serve(item.root)).rejects.toThrow("Modified page")
  })

  test("refuses nonempty task directory", async () => {
    const item = await fixture()
    const ext = join(join(item.root, ".."), "extension")
    expect(prepare(item.root, ext)).rejects.toThrow("empty disposable task directory")
  })
})
