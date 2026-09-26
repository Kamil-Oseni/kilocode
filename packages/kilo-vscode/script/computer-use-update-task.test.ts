import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepare, score, serve } from "./computer-use-update-task"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "raya-update-test-"))
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
  return { dir, root, ext }
}

async function update(url: string, body = "{}") {
  return fetch(new URL("/update", url), { method: "POST", headers: { "content-type": "application/json" }, body })
}

describe("disposable portable-app update task", () => {
  test("setup alone fails; one local update changes actual installed file and passes", async () => {
    const item = await fixture()
    expect(await score(item.root)).toMatchObject({ correctFinalState: false, releaseGateEligible: false })
    const app = await serve(item.root)
    try {
      expect((await update(app.url)).status).toBe(201)
      expect(await score(item.root)).toMatchObject({
        correctFinalState: true,
        updateObserved: true,
        replay: false,
        releaseGateEligible: false,
      })
      expect(await readFile(join(item.root, "App", "portable-app.txt"), "utf8")).toContain("Version: 2")
      expect((await update(app.url)).status).toBe(409)
    } finally {
      app.server.stop(true)
    }
  })

  test("rejects invalid request and altered update package before dispatch", async () => {
    const item = await fixture()
    const app = await serve(item.root)
    try {
      expect((await update(app.url, "wrong")).status).toBe(400)
      await writeFile(join(item.root, "Updates", "portable-app-v2.txt"), "tampered")
      expect((await update(app.url)).status).toBe(409)
      expect(await score(item.root)).toMatchObject({
        correctFinalState: false,
        changed: ["App/portable-app.txt", "Updates/portable-app-v2.txt"],
      })
    } finally {
      app.server.stop(true)
    }
  })

  test("rejects false receipt, replay, and unrelated effects", async () => {
    const item = await fixture()
    const task = JSON.parse(await readFile(join(item.root, "task.json"), "utf8")) as { runId: string }
    const line = JSON.stringify({ runId: task.runId, action: "local-portable-update", from: 1, to: 2 }) + "\n"
    await writeFile(join(item.root, "update.jsonl"), line)
    expect(await score(item.root)).toMatchObject({ correctFinalState: false, changed: ["App/portable-app.txt"] })
    await writeFile(join(item.root, "update.jsonl"), line + line)
    await writeFile(join(item.root, "extra.txt"), "unexpected")
    expect(await score(item.root)).toMatchObject({
      correctFinalState: false,
      replay: true,
      unexpected: ["extra.txt"],
      changed: ["App/portable-app.txt", "update.jsonl"],
    })
  })

  test("refuses occupied workspace and modified contract", async () => {
    const item = await fixture()
    const task = JSON.parse(await readFile(join(item.root, "task.json"), "utf8")) as Record<string, unknown>
    task.scenario = "settings-navigation"
    await writeFile(join(item.root, "task.json"), JSON.stringify(task))
    expect(score(item.root)).rejects.toThrow("Invalid or modified update task manifest")
    const root = join(item.dir, "occupied")
    await mkdir(root)
    await writeFile(join(root, "keep.txt"), "keep")
    expect(prepare(root, item.ext)).rejects.toThrow("empty disposable task directory")
    expect(await readFile(join(root, "keep.txt"), "utf8")).toBe("keep")
  })
})
