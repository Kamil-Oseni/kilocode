import { afterEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { paragraphs, prepare, score } from "./computer-use-office-document-task"

const execute = promisify(execFile)
const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function document(root: string, lines: string[], name: string) {
  const stage = join(root, `${name}-parts`)
  await mkdir(join(stage, "_rels"), { recursive: true })
  await mkdir(join(stage, "word"), { recursive: true })
  await writeFile(
    join(stage, "[Content_Types].xml"),
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  )
  await writeFile(
    join(stage, "_rels", ".rels"),
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  )
  await writeFile(
    join(stage, "word", "document.xml"),
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines.map((line) => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`).join("")}<w:sectPr/></w:body></w:document>`,
  )
  const zip = join(root, `${name}.zip`)
  await execute("tar", ["-a", "-cf", zip, "-C", stage, "[Content_Types].xml", "_rels", "word"])
  const path = join(root, `${name}.docx`)
  await copyFile(zip, path)
  return path
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "raya-office-test-"))
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
  const source = await document(
    dir,
    ["Raya office editing task", "Decision: Pending", "Owner: Unassigned", "Notes: Keep unchanged."],
    "source",
  )
  await prepare(root, ext, source)
  const input = JSON.parse(await readFile(join(root, "task.json"), "utf8")) as { code: string }
  return { dir, root, ext, source, input }
}

describe("installed Office document task", () => {
  test("scores exact saved OOXML paragraphs and unchanged baseline", async () => {
    const item = await fixture()
    expect(await score(item.root)).toMatchObject({ correctFinalState: false, releaseGateEligible: false })
    const edited = await document(
      item.dir,
      [
        "Raya office editing task",
        `Decision: Approved for ${item.input.code}`,
        "Owner: Raya",
        "Notes: Keep unchanged.",
      ],
      "edited",
    )
    expect(paragraphs(await readFile(edited))).toEqual([
      "Raya office editing task",
      `Decision: Approved for ${item.input.code}`,
      "Owner: Raya",
      "Notes: Keep unchanged.",
    ])
    await copyFile(edited, join(item.root, "Working.docx"))
    expect(await score(item.root)).toMatchObject({ correctFinalState: true, releaseGateEligible: false })
  })

  test("rejects wrong content, added paragraph, damaged baseline, and extra artifact", async () => {
    const item = await fixture()
    const wrong = await document(
      item.dir,
      ["Raya office editing task", "Decision: Approved for WRONG", "Owner: Raya", "Notes: Keep unchanged."],
      "wrong",
    )
    await copyFile(wrong, join(item.root, "Working.docx"))
    expect((await score(item.root)).correctFinalState).toBe(false)
    const extra = await document(
      item.dir,
      [
        "Raya office editing task",
        `Decision: Approved for ${item.input.code}`,
        "Owner: Raya",
        "Notes: Keep unchanged.",
        "Unexpected change",
      ],
      "extra",
    )
    await copyFile(extra, join(item.root, "Working.docx"))
    expect((await score(item.root)).correctFinalState).toBe(false)
    await writeFile(join(item.root, "baseline.docx"), "damaged")
    await writeFile(join(item.root, "other.txt"), "extra")
    expect(await score(item.root)).toMatchObject({
      correctFinalState: false,
      changed: ["baseline.docx"],
      unexpected: ["other.txt"],
    })
  })

  test("rejects non-DOCX source and malformed edited package", async () => {
    const item = await fixture()
    await writeFile(join(item.root, "Working.docx"), "not a zip")
    expect((await score(item.root)).correctFinalState).toBe(false)
    await writeFile(join(item.dir, "bad.docx"), "not a zip")
    await expect(prepare(join(item.dir, "second"), item.ext, join(item.dir, "bad.docx"))).rejects.toThrow()
    await expect(prepare(item.root, item.ext, item.source)).rejects.toThrow("empty disposable")
  })
})
