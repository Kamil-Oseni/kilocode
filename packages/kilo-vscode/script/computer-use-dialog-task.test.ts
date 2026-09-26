import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepare, score } from "./computer-use-dialog-task"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "raya-dialog-test-"))
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

async function record(root: string, override: Record<string, unknown> = {}) {
  const task = JSON.parse(await readFile(join(root, "task.json"), "utf8")) as {
    runId: string
    code: string
    expected: string
  }
  const row = {
    runId: task.runId,
    code: task.code,
    choice: task.expected,
    dialog: "native-winforms-messagebox-v1",
    ...override,
  }
  await writeFile(join(root, "decision.jsonl"), JSON.stringify(row) + "\n")
}

describe("installed native dialog scorer", () => {
  test("setup alone cannot pass; one exact saved choice can", async () => {
    const item = await fixture()
    const task = await prepare(item.root, item.ext)
    expect(task.manifest.scenario).toBe("dialog-handling")
    expect(await score(item.root)).toMatchObject({ correctFinalState: false, releaseGateEligible: false })
    await record(item.root)
    expect(await score(item.root)).toMatchObject({
      correctFinalState: true,
      choices: 1,
      replay: false,
      releaseGateEligible: false,
    })
  })

  test("rejects wrong choice, duplicate decision, and malformed journal", async () => {
    const item = await fixture()
    await prepare(item.root, item.ext)
    const task = JSON.parse(await readFile(join(item.root, "task.json"), "utf8")) as { expected: string }
    await record(item.root, { choice: task.expected === "Yes" ? "No" : "Yes" })
    expect(await score(item.root)).toMatchObject({ correctFinalState: false, changed: ["decision.jsonl"] })
    const first = await readFile(join(item.root, "decision.jsonl"), "utf8")
    await writeFile(join(item.root, "decision.jsonl"), first + first)
    expect(await score(item.root)).toMatchObject({ correctFinalState: false, choices: 2, replay: true })
    await writeFile(join(item.root, "decision.jsonl"), "not-json\n")
    expect(await score(item.root)).toMatchObject({ correctFinalState: false, changed: ["decision.jsonl"] })
  })

  test("rejects altered script, extra files, and changed task contract", async () => {
    const item = await fixture()
    await prepare(item.root, item.ext)
    await record(item.root)
    await writeFile(join(item.root, "dialog.ps1"), "changed")
    await writeFile(join(item.root, "extra.txt"), "extra")
    expect(await score(item.root)).toMatchObject({
      correctFinalState: false,
      changed: ["dialog.ps1"],
      unexpected: ["extra.txt"],
    })
    const task = JSON.parse(await readFile(join(item.root, "task.json"), "utf8")) as Record<string, unknown>
    task.scenario = "settings-navigation"
    await writeFile(join(item.root, "task.json"), JSON.stringify(task))
    expect(score(item.root)).rejects.toThrow("Invalid or modified dialog task manifest")
  })

  test("refuses to overwrite an occupied workspace", async () => {
    const item = await fixture()
    await mkdir(item.root)
    await writeFile(join(item.root, "keep.txt"), "keep")
    expect(prepare(item.root, item.ext)).rejects.toThrow("empty disposable task directory")
    expect(await readFile(join(item.root, "keep.txt"), "utf8")).toBe("keep")
  })
})
