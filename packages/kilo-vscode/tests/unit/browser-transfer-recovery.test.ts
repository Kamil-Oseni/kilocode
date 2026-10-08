import { expect, test, spyOn } from "bun:test"
import { randomUUID } from "node:crypto"
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BrowserTransfers } from "../../src/services/browser-automation/browser-transfer"

test("restores ordinary receipts but refuses oversized and linked metadata without exposing contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-download-recovery-"))
  const log = spyOn(console, "error").mockImplementation(() => undefined)
  const marker = "private-receipt-content"
  const ids = Array.from({ length: 4 }, () => randomUUID())
  const receipt = (id: string) => ({
    version: 1,
    id,
    tabID: "tab",
    profile: "profile",
    status: "completed",
    filename: "report.txt",
    url: "https://example.test/report",
    createdAt: 1,
    updatedAt: 1,
  })
  try {
    for (const id of ids) await mkdir(join(root, id))
    await writeFile(join(root, ids[0], "receipt.json"), JSON.stringify(receipt(ids[0])))
    await writeFile(
      join(root, ids[1], "receipt.json"),
      JSON.stringify({
        ...receipt(ids[1]),
        origin: { requestID: marker.repeat(40000), sessionID: "session", directory: root },
      }),
    )
    const external = join(root, "external.json")
    const original = JSON.stringify(receipt(ids[2]))
    await writeFile(external, original)
    await link(external, join(root, ids[2], "receipt.json"))
    await writeFile(join(root, ids[3], "receipt.json"), JSON.stringify({ ...receipt(ids[3]), version: marker }))
    const transfers = new BrowserTransfers(root, "profile")
    expect((await transfers.list()).transfers.map((item) => item.id)).toEqual([ids[0]])
    expect(await readFile(external, "utf8")).toBe(original)
    expect(log.mock.calls).toHaveLength(3)
    expect(JSON.stringify(log.mock.calls)).not.toContain(marker)
  } finally {
    log.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
