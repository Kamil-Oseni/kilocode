import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepare, score, serve } from "./computer-use-manual-takeover-task"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "raya-takeover-test-"))
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

describe("installed manual takeover task", () => {
  test("requires ordered handoff and exact entries", async () => {
    const item = await fixture()
    expect(await score(item.root)).toMatchObject({ correctFinalState: false, releaseGateEligible: false })
    const site = await serve(item.root)
    const post = (kind: string, value?: string) =>
      fetch(new URL("/event", site.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: item.input.runId, kind, ...(value ? { value } : {}) }),
      })
    try {
      expect((await fetch(site.url)).status).toBe(200)
      expect((await post("takeover")).status).toBe(409)
      expect((await post("start", "wrong")).status).toBe(400)
      expect((await post("start", `North-${item.input.seed}`)).status).toBe(201)
      expect((await post("takeover")).status).toBe(201)
      expect((await post("finish", `South-${item.input.seed}`)).status).toBe(409)
      expect((await post("human", `Human-${item.input.seed}`)).status).toBe(201)
      expect((await post("handback")).status).toBe(201)
      expect((await post("finish", `South-${item.input.seed}`)).status).toBe(201)
      expect((await post("finish", `South-${item.input.seed}`)).status).toBe(409)
      expect(await score(item.root)).toMatchObject({
        correctFinalState: true,
        releaseGateEligible: false,
        events: ["start", "takeover", "human", "handback", "finish"],
      })
    } finally {
      site.server.stop(true)
    }
  })

  test("rejects tampering, foreign events, and duplicate effects", async () => {
    const item = await fixture()
    const site = await serve(item.root)
    try {
      const wrong = await fetch(new URL("/event", site.url), {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://other.example" },
        body: JSON.stringify({ runId: item.input.runId, kind: "start", value: `North-${item.input.seed}` }),
      })
      expect(wrong.status).toBe(403)
    } finally {
      site.server.stop(true)
    }
    const path = join(item.root, "events.jsonl")
    const event = (kind: string, value?: string) =>
      JSON.stringify({ runId: item.input.runId, kind, ...(value ? { value } : {}), at: new Date().toISOString() })
    const lines = [
      event("start", `North-${item.input.seed}`),
      event("takeover"),
      event("human", `Human-${item.input.seed}`),
      event("handback"),
      event("finish", `South-${item.input.seed}`),
    ]
    await writeFile(path, `${lines.join("\n")}\n`)
    expect((await score(item.root)).correctFinalState).toBe(true)
    await writeFile(path, `${lines.join("\n")}\n${lines[4]}\n`)
    expect((await score(item.root)).correctFinalState).toBe(false)
    await writeFile(path, `${lines.join("\n")}\n`.replace(`Human-${item.input.seed}`, "wrong"))
    expect((await score(item.root)).correctFinalState).toBe(false)
    await writeFile(path, "invalid\n")
    expect(await score(item.root)).toMatchObject({ correctFinalState: false, changed: ["events.jsonl"] })
    await writeFile(join(item.root, "page.html"), "changed")
    await writeFile(join(item.root, "extra.txt"), "extra")
    expect(await score(item.root)).toMatchObject({
      correctFinalState: false,
      changed: ["page.html", "events.jsonl"],
      unexpected: ["extra.txt"],
    })
    expect(serve(item.root)).rejects.toThrow("Modified page")
  })
})
