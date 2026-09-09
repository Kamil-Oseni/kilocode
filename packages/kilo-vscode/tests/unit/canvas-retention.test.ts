import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { stop } from "esbuild-wasm"
import { CanvasCompiler } from "../../src/services/canvas/canvas-compiler"

const dirs: string[] = []
afterAll(stop)
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

test("bounds revision history after restart while preserving saved and failed recovery revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-retention-"))
  dirs.push(root)
  const output = join(root, "bundles")
  const compiler = new CanvasCompiler(output)
  const first = await compiler.create(root, "report", "export default function Report() { return <p>Saved</p> }", {})
  await compiler.commit(first)
  const second = await compiler.create(root, "report", "export default function Report() { return <p>Current</p> }", {})
  await compiler.commit(second)
  const directory = dirname(first.bundle!)
  const draft = await compiler.draft(first)
  await Promise.all([first.bundle!, draft.path].map((path) => utimes(path, 1, 1)))
  const revisions: string[] = []
  for (let index = 0; index < 25; index++) {
    const revision = randomUUID()
    revisions.push(revision)
    for (const suffix of ["draft.json", "js"]) {
      const path = join(directory, `report.${revision}.${suffix}`)
      await writeFile(path, "old cache")
      await utimes(path, index + 2, index + 2)
    }
  }
  const unrelated = [`other.${randomUUID()}.js`, "report.notes.json", "report.current.json.backup"]
  await Promise.all(unrelated.map((name) => writeFile(join(directory, name), "preserve")))
  const reopened = new CanvasCompiler(output)
  const failed = await reopened.create(root, "report", "invalid draft", { value: 9 })
  expect(failed.status).toBe("error")
  const files = await readdir(directory)
  expect(files.filter((name) => name.endsWith(".draft.json"))).toHaveLength(21)
  expect(files).not.toContain(`report.${revisions[0]}.js`)
  expect(files).not.toContain(`report.${revisions[0]}.draft.json`)
  expect(files).toContain(`report.${revisions[24]}.js`)
  expect(files).toContain(`report.${first.revision}.js`)
  for (const name of unrelated) expect(await readFile(join(directory, name), "utf8")).toBe("preserve")
  expect((await reopened.draft(failed)).data).toEqual({ value: 9 })
  expect((await reopened.restore(root, "report"))?.revision).toBe(second.revision)
  expect((await reopened.rollback(second, () => true))?.revision).toBe(first.revision)
  const retained = join(directory, `report.${revisions[0]}.draft.json`)
  await writeFile(retained, "recovery evidence")
  await utimes(retained, 1, 1)
  await writeFile(join(directory, "report.current.json"), "{invalid")
  const notice = spyOn(console, "error").mockImplementation(() => undefined)
  try {
    const next = await reopened.create(root, "report", "another invalid draft", {})
    expect(next.status).toBe("error")
    expect(await readFile(retained, "utf8")).toBe("recovery evidence")
    expect(notice).toHaveBeenCalled()
  } finally {
    notice.mockRestore()
  }
})
