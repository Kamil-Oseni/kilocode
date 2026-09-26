import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { interrupt, prepare, score, serve } from "./computer-use-restart-task"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "raya-restart-test-"))
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
  const input = JSON.parse(await readFile(join(root, "task.json"), "utf8")) as { runId: string; code: string }
  return { root, ext, input }
}

async function post(url: string, kind: string, runId: string, value?: string, headers?: Record<string, string>) {
  return fetch(new URL(`/${kind}`, url), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ runId, ...(value === undefined ? {} : { value }) }),
  })
}

describe("installed backend restart task fixture", () => {
  test("requires a saved draft, external marker, new server, and one exact final value", async () => {
    const item = await fixture()
    expect(await score(item.root)).toMatchObject({ correctFinalState: false, releaseGateEligible: false })
    const first = await serve(item.root)
    try {
      expect((await fetch(first.url)).status).toBe(200)
      expect((await post(first.url, "finish", item.input.runId, `${item.input.code}-complete`)).status).toBe(409)
      expect((await post(first.url, "draft", item.input.runId, item.input.code)).status).toBe(201)
      expect((await post(first.url, "draft", item.input.runId, item.input.code)).status).toBe(409)
    } finally {
      first.server.stop(true)
    }
    expect(await score(item.root)).toMatchObject({ correctFinalState: false })
    await interrupt(item.root)
    const second = await serve(item.root)
    try {
      expect((await post(second.url, "finish", item.input.runId, `${item.input.code}-complete`)).status).toBe(409)
      expect((await post(second.url, "resume", item.input.runId)).status).toBe(201)
      expect((await post(second.url, "finish", item.input.runId, `${item.input.code}-complete`)).status).toBe(201)
      expect((await post(second.url, "finish", item.input.runId, `${item.input.code}-complete`)).status).toBe(409)
      expect(await score(item.root)).toMatchObject({
        correctFinalState: true,
        interruptionRecovered: true,
        duplicateEffects: false,
        events: ["draft", "interrupt", "resume", "finish"],
        releaseGateEligible: false,
      })
    } finally {
      second.server.stop(true)
    }
  })

  test("same fixture server cannot masquerade as a restart", async () => {
    const item = await fixture()
    const site = await serve(item.root)
    try {
      await post(site.url, "draft", item.input.runId, item.input.code)
      await interrupt(item.root)
      await post(site.url, "resume", item.input.runId)
      await post(site.url, "finish", item.input.runId, `${item.input.code}-complete`)
      expect(await score(item.root)).toMatchObject({ correctFinalState: false, interruptionRecovered: false })
    } finally {
      site.server.stop(true)
    }
  })

  test("wrong final value, duplicate journal effect, malformed event, and modified page fail", async () => {
    const item = await fixture()
    const first = await serve(item.root)
    await post(first.url, "draft", item.input.runId, item.input.code)
    first.server.stop(true)
    await interrupt(item.root)
    const second = await serve(item.root)
    await post(second.url, "resume", item.input.runId)
    await post(second.url, "finish", item.input.runId, "wrong")
    second.server.stop(true)
    expect(await score(item.root)).toMatchObject({ correctFinalState: false, interruptionRecovered: true })
    const path = join(item.root, "events.jsonl")
    const saved = await readFile(path, "utf8")
    await writeFile(path, `${saved}${saved.split("\n")[3]}\n`)
    expect(await score(item.root)).toMatchObject({ correctFinalState: false, duplicateEffects: true })
    await writeFile(path, "invalid\n")
    expect(await score(item.root)).toMatchObject({ correctFinalState: false, changed: ["events.jsonl"] })
    await writeFile(join(item.root, "page.html"), "changed")
    expect(await score(item.root)).toMatchObject({ correctFinalState: false, changed: ["page.html", "events.jsonl"] })
    expect(serve(item.root)).rejects.toThrow("Modified page")
  })

  test("rejects wrong run, origin, oversized request, and premature marker", async () => {
    const item = await fixture()
    expect(interrupt(item.root)).rejects.toThrow("Draft must be saved first")
    const site = await serve(item.root)
    try {
      expect((await post(site.url, "draft", "wrong", item.input.code)).status).toBe(403)
      expect(
        (await post(site.url, "draft", item.input.runId, item.input.code, { origin: "https://other.example" })).status,
      ).toBe(403)
      expect((await post(site.url, "draft", item.input.runId, "x".repeat(600))).status).toBe(413)
      expect(
        (await post(site.url, "draft", item.input.runId, item.input.code, { "content-type": "text/plain" })).status,
      ).toBe(415)
      expect((await post(site.url, "resume", item.input.runId)).status).toBe(409)
    } finally {
      site.server.stop(true)
    }
    expect(prepare(item.root, item.ext)).rejects.toThrow("empty disposable task directory")
  })
})
