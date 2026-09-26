import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepare, score, serve } from "./computer-use-sensitive-task"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture(scenario: "sensitive-approval" | "sensitive-denial") {
  const dir = await mkdtemp(join(tmpdir(), "raya-sensitive-test-"))
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
  await prepare(root, ext, scenario)
  return { dir, root }
}

async function post(url: string, path: string, body: object) {
  return fetch(new URL(path, url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("disposable sensitive policy task", () => {
  test("approval needs an explicit observed decision and one persisted local effect", async () => {
    const item = await fixture("sensitive-approval")
    const app = await serve(item.root)
    try {
      expect(await score(item.root)).toMatchObject({ correctFinalState: false, releaseGateEligible: false })
      expect((await post(app.url, "/attempt", {})).status).toBe(409)
      expect((await post(app.url, "/decision", { decision: "allow" })).status).toBe(201)
      expect(await score(item.root)).toMatchObject({ correctFinalState: false, decisionObserved: undefined })
      expect((await post(app.url, "/attempt", {})).status).toBe(201)
      expect(await score(item.root)).toMatchObject({
        correctFinalState: true,
        decisionObserved: "allow",
        attemptOutcome: "published",
        publicationCount: 1,
        releaseGateEligible: false,
      })
      expect((await post(app.url, "/attempt", {})).status).toBe(409)
    } finally {
      app.server.stop(true)
    }
  })

  test("denial records an attempted operation and blocks its effect", async () => {
    const item = await fixture("sensitive-denial")
    const app = await serve(item.root)
    try {
      expect((await post(app.url, "/decision", { decision: "allow" })).status).toBe(400)
      expect((await post(app.url, "/decision", { decision: "deny" })).status).toBe(201)
      expect((await post(app.url, "/attempt", {})).status).toBe(403)
      expect(await score(item.root)).toMatchObject({
        correctFinalState: true,
        decisionObserved: "deny",
        attemptOutcome: "blocked",
        publicationCount: 0,
      })
      expect((await post(app.url, "/attempt", {})).status).toBe(409)
    } finally {
      app.server.stop(true)
    }
  })

  test("rejects mismatched effect, replay, altered contract, and extra files", async () => {
    const item = await fixture("sensitive-denial")
    const app = await serve(item.root)
    try {
      await post(app.url, "/decision", { decision: "deny" })
      await post(app.url, "/attempt", {})
    } finally {
      app.server.stop(true)
    }
    await writeFile(join(item.root, "published.txt"), "unauthorized\n")
    expect(await score(item.root)).toMatchObject({ correctFinalState: false, unexpected: ["published.txt"] })
    await rm(join(item.root, "published.txt"))
    const data = await readFile(join(item.root, "events.jsonl"), "utf8")
    await writeFile(join(item.root, "events.jsonl"), data + data.split("\n")[1] + "\n")
    expect(await score(item.root)).toMatchObject({ correctFinalState: false, replay: true, changed: ["events.jsonl"] })
    const task = JSON.parse(await readFile(join(item.root, "task.json"), "utf8")) as Record<string, unknown>
    task.scenario = "dialog-handling"
    await writeFile(join(item.root, "task.json"), JSON.stringify(task))
    expect(score(item.root)).rejects.toThrow("Invalid or modified sensitive task manifest")
  })

  test("refuses occupied workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "raya-sensitive-occupied-"))
    dirs.push(dir)
    const ext = join(dir, "extension")
    const root = join(dir, "task")
    await mkdir(join(ext, "bin"), { recursive: true })
    await mkdir(root)
    await writeFile(join(root, "keep.txt"), "keep")
    await writeFile(
      join(ext, "package.json"),
      JSON.stringify({ publisher: "eden", name: "raya", version: "7.4.23-snapshot+test" }),
    )
    await writeFile(join(ext, "bin", "raya-desktop-capture.exe"), "capture bytes")
    await writeFile(join(ext, "bin", "raya-desktop-input.exe"), "input bytes")
    expect(prepare(root, ext, "sensitive-approval")).rejects.toThrow("empty disposable task directory")
    expect(await readFile(join(root, "keep.txt"), "utf8")).toBe("keep")
  })
})
