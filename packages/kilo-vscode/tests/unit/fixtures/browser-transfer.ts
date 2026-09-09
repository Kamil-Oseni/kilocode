import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium } from "playwright-core"
import { BrowserSession, type BrowserContextLike } from "../../../src/services/browser-automation/browser-session"
import { BrowserTransfers } from "../../../src/services/browser-automation/browser-transfer"

const dir = await mkdtemp(join(tmpdir(), "raya-downloads-"))
const counts = new Map<string, number>()
const block = Buffer.alloc(65536, 42)
const server = createServer((request, response) => {
  const url = request.url ?? "/"
  counts.set(url, (counts.get(url) ?? 0) + 1)
  if (url === "/") {
    response.end(
      "<a href=\"/file\" download>Export</a><button onclick=\"setTimeout(() => { const a = document.createElement('a'); a.href='/delayed'; a.download=''; a.click() }, 100)\">Delayed</button><a href=\"/slow\" download>Slow</a>",
    )
    return
  }
  response.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": 'attachment; filename="../../report.txt"',
  })
  if (url === "/slow") {
    const timer = setInterval(() => response.write(block), 20)
    response.on("close", () => clearInterval(timer))
    return
  }
  let count = 0
  const send = () => {
    while (count < 640) {
      count++
      if (!response.write(block)) {
        response.once("drain", send)
        return
      }
    }
    response.end()
  }
  send()
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const address = server.address()
assert.ok(address && typeof address !== "string")
const context = await chromium.launchPersistentContext(dir, {
  executablePath: process.env.RAYA_TEST_BROWSER,
  headless: true,
})
const session = new BrowserSession(dir, async () => context as unknown as BrowserContextLike)
const origin = { requestID: "export-1", sessionID: "task-1", directory: dir }
const until = async <T>(read: () => Promise<T | undefined>) => {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Download condition timed out")
}
try {
  await session.ready()
  const tabID = (await session.inventory())[0].id
  await session.execute({ operation: "navigate", tabID, url: `http://127.0.0.1:${address.port}/`, origin })
  const result = await session.execute({
    operation: "click",
    tabID,
    selector: { kind: "role", role: "link", name: "Export" },
    origin,
  })
  assert.equal(result.transfers?.length, 1)
  const id = result.transfers![0].id
  assert.equal(result.transfers![0].origin?.requestID, origin.requestID)
  const complete = async (id: string, owner = origin) =>
    until(async () => {
      const result = await session.execute({ operation: "download", action: "inspect", transferID: id, origin: owner })
      assert.equal(result.operation, "download")
      if (result.operation !== "download") throw new Error("Unexpected result")
      assert.ok(!["failed", "unknown"].includes(result.transfers[0].status), JSON.stringify(result))
      return result.transfers[0].status === "completed" ? result : undefined
    })
  const first = await complete(id)
  assert.equal(first.transfers[0].bytes, 640 * block.length)
  const bytes = await readFile(first.artifact!)
  assert.equal(createHash("sha256").update(bytes).digest("hex"), first.transfers[0].sha256)
  assert.equal(first.artifact, join(dir, "raya-downloads", id, "artifact"))
  await assert.rejects(
    session.execute({
      operation: "download",
      action: "inspect",
      transferID: id,
      origin: { ...origin, sessionID: "another-task" },
    }),
    /another task/,
  )
  assert.equal(counts.get("/file"), 1)
  const duplicate = await session.execute({
    operation: "download",
    action: "start",
    tabID,
    selector: "a[href='/file']",
    origin: { ...origin, requestID: "export-2" },
  })
  assert.equal(duplicate.operation, "download")
  const second = await complete(duplicate.transfers![0].id)
  assert.notEqual(second.artifact, first.artifact)
  assert.equal(counts.get("/file"), 2)
  const delayed = await session.execute({
    operation: "download",
    action: "start",
    tabID,
    selector: { kind: "role", role: "button", name: "Delayed" },
    origin: { ...origin, requestID: "delayed" },
  })
  assert.equal(delayed.transfers![0].origin?.requestID, "delayed")
  await complete(delayed.transfers![0].id)
  assert.equal(counts.get("/delayed"), 1)
  const navigation = await session.execute({
    operation: "navigate",
    tabID,
    url: `http://127.0.0.1:${address.port}/direct`,
    origin: { ...origin, requestID: "direct" },
  })
  assert.equal(navigation.navigation, "download")
  await complete(navigation.transfers![0].id)
  assert.equal(counts.get("/direct"), 1)
  const opened = await session.execute({
    operation: "tabs",
    action: "open",
    url: `http://127.0.0.1:${address.port}/opened`,
    origin: { ...origin, requestID: "opened" },
  })
  assert.equal(opened.transfers?.length, 1)
  assert.equal(opened.transfers![0].tabID, opened.tabID)
  await complete(opened.transfers![0].id)
  assert.equal(counts.get("/opened"), 1)
  const other = context.pages().find((page) => page.url() === "about:blank")!
  await other.goto(`http://127.0.0.1:${address.port}/`)
  const owner = { ...origin, sessionID: "task-2", requestID: "parallel-2" }
  const parallel = await Promise.all([
    session.execute({
      operation: "download",
      action: "start",
      tabID,
      selector: "a[href='/slow']",
      origin: { ...origin, requestID: "parallel-1" },
    }),
    session.execute({
      operation: "download",
      action: "start",
      tabID: opened.tabID,
      selector: "a[href='/slow']",
      origin: owner,
    }),
  ])
  const ids = parallel.map((result) => result.transfers![0].id)
  await until(async () =>
    (await session.downloads()).transfers.filter((item) => ids.includes(item.id) && item.status === "receiving")
      .length === 2
      ? true
      : undefined,
  )
  assert.equal(parallel[0].transfers![0].tabID, tabID)
  assert.equal(parallel[1].transfers![0].tabID, opened.tabID)
  await assert.rejects(
    session.execute({ operation: "download", action: "inspect", transferID: ids[1], origin }),
    /another task/,
  )
  await session.execute({ operation: "download", action: "cancel", transferID: ids[0], origin })
  await session.execute({ operation: "download", action: "cancel", transferID: ids[1], origin: owner })
  const copy = join(dir, "saved-report.txt")
  await session.saveDownload(id, copy)
  assert.equal(
    createHash("sha256")
      .update(await readFile(copy))
      .digest("hex"),
    first.transfers[0].sha256,
  )
  await writeFile(copy, "preserve")
  await assert.rejects(session.saveDownload(id, copy), /Destination exists/)
  assert.equal(await readFile(copy, "utf8"), "preserve")
  await session.saveDownload(id, copy, true)
  assert.equal(
    createHash("sha256")
      .update(await readFile(copy))
      .digest("hex"),
    first.transfers[0].sha256,
  )
  const slow = await session.execute({
    operation: "download",
    action: "start",
    tabID,
    selector: "a[href='/slow']",
    origin: { ...origin, requestID: "cancelled" },
  })
  await until(async () =>
    (await session.downloads()).transfers.find(
      (item) => item.id === slow.transfers![0].id && item.status === "receiving",
    ),
  )
  const cancelled = await session.execute({
    operation: "download",
    action: "cancel",
    transferID: slow.transfers![0].id,
    origin,
  })
  assert.equal(cancelled.transfers![0].status, "cancelled")
  await assert.rejects(session.downloadArtifact(slow.transfers![0].id), /not complete/)
  await context.pages()[0].evaluate(() => {
    const button = document.createElement("button")
    button.textContent = "Prepare"
    button.onclick = () =>
      Reflect.set(globalThis, "exportLater", () => {
        const link = document.createElement("a")
        link.href = "/broken-receipt"
        link.download = ""
        link.click()
      })
    document.body.append(button)
  })
  const broken = await session.execute({
    operation: "download",
    action: "start",
    tabID,
    selector: { kind: "role", role: "button", name: "Prepare" },
    origin: { ...origin, requestID: "broken" },
  })
  const receipt = join(dir, "raya-downloads", broken.transfers![0].id, "receipt.json")
  await unlink(receipt)
  await mkdir(receipt)
  await context.pages()[0].evaluate(() => Reflect.get(globalThis, "exportLater")())
  await until(async () =>
    (
      await session.execute({ operation: "download", action: "inspect", transferID: broken.transfers![0].id, origin })
    ).transfers?.find((item) => item.status === "unknown"),
  )
  assert.equal(await session.downloadArtifact(id), first.artifact)
  await writeFile(second.artifact!, "changed")
  await assert.rejects(session.downloadArtifact(second.transfers[0].id), /no longer matches/)
  const interrupted = await session.execute({
    operation: "download",
    action: "start",
    tabID,
    selector: "a[href='/slow']",
    origin: { ...origin, requestID: "interrupted" },
  })
  await until(async () =>
    (await session.downloads()).transfers.find(
      (item) => item.id === interrupted.transfers![0].id && item.status === "receiving",
    ),
  )
  await session.dispose()
  const recovered = new BrowserTransfers(join(dir, "raya-downloads"), dir)
  try {
    assert.equal((await recovered.list(origin, interrupted.transfers![0].id)).transfers[0].status, "unknown")
    assert.equal(await recovered.artifact(id, origin), first.artifact)
    assert.equal(counts.get("/slow"), 4)
  } finally {
    recovered.dispose()
  }
} finally {
  await session.dispose()
  await context.close()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
}
