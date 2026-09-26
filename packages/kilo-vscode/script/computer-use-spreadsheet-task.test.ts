import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepare, score } from "./computer-use-spreadsheet-task"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "raya-sheet-test-"))
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
  const input = JSON.parse(await readFile(join(root, "task.json"), "utf8")) as { seed: number }
  return { root, ext, seed: input.seed }
}

function completed(seed: number) {
  const values = [125, 200, 275].map((cents, index) => (seed + index * 3) * cents)
  const lines = values.map(
    (cents, index) =>
      `${["Aster", "Birch", "Cedar"][index]},${seed + index * 3},${(125 + index * 75) / 100},${cents / 100}`,
  )
  return `Project,Units,Unit price,Extended\n${lines.join("\n")}\nTotal,,,${values.reduce((sum, value) => sum + value, 0) / 100}\n`
}

describe("installed spreadsheet editing task scorer", () => {
  test("blank workbook fails and exact saved numeric cells pass independent arithmetic", async () => {
    const item = await fixture()
    expect(await score(item.root)).toMatchObject({ correctFinalState: false, releaseGateEligible: false })
    await writeFile(join(item.root, "workbook.csv"), completed(item.seed).replace(/\n/g, "\r\n"))
    expect(await score(item.root)).toMatchObject({ correctFinalState: true, releaseGateEligible: false })
  })

  test("wrong extended value, wrong total, and formula text fail", async () => {
    const item = await fixture()
    const path = join(item.root, "workbook.csv")
    const good = completed(item.seed)
    const lines = good.trimEnd().split("\n")
    const first = lines[1].split(",")
    first[3] = String(Number(first[3]) + 1)
    lines[1] = first.join(",")
    await writeFile(path, `${lines.join("\n")}\n`)
    expect(await score(item.root)).toMatchObject({
      correctFinalState: false,
      reason: "Extended value is wrong in Aster",
    })
    await writeFile(path, good.replace(/Total,,,[^\n]+/, "Total,,,0"))
    expect(await score(item.root)).toMatchObject({
      correctFinalState: false,
      reason: "The independently calculated total is wrong",
    })
    await writeFile(path, good.replace(/Total,,,[^\n]+/, 'Total,,,"=SUM(D2:D4)"'))
    expect(await score(item.root)).toMatchObject({ correctFinalState: false, reason: "Invalid spreadsheet shape" })
  })

  test("changed source input, extra rows, source tamper, and unrelated file fail", async () => {
    const item = await fixture()
    const path = join(item.root, "workbook.csv")
    const good = completed(item.seed)
    await writeFile(path, good.replace(`Aster,${item.seed},`, `Aster,${item.seed + 1},`))
    expect(await score(item.root)).toMatchObject({ correctFinalState: false, reason: "Source inputs changed in Aster" })
    await writeFile(path, `${good}Hidden,1,1,1\n`)
    expect(await score(item.root)).toMatchObject({ correctFinalState: false, reason: "Invalid spreadsheet shape" })
    await writeFile(path, good)
    await writeFile(join(item.root, "source.csv"), "tampered")
    await writeFile(join(item.root, "extra.txt"), "extra")
    expect(await score(item.root)).toMatchObject({
      correctFinalState: false,
      changed: ["source.csv"],
      unexpected: ["extra.txt"],
    })
  })

  test("rejects modified manifest and nonempty task directory", async () => {
    const item = await fixture()
    expect(prepare(item.root, item.ext)).rejects.toThrow("empty disposable task directory")
    const path = join(item.root, "task.json")
    const input = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    input.seed = 999
    await writeFile(path, JSON.stringify(input))
    expect(score(item.root)).rejects.toThrow("Invalid or modified spreadsheet task manifest")
  })
})
