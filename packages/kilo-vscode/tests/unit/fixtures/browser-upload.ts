import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium } from "playwright-core"
import { BrowserSession, type BrowserContextLike } from "../../../src/services/browser-automation/browser-session"
import {
  BrowserUploads,
  type UploadInfo,
  type UploadTransport,
} from "../../../src/services/browser-automation/browser-upload"

const dir = await mkdtemp(join(tmpdir(), "raya-uploads-"))
const received: Array<{ bytes: number; hash: string; name: string }> = []
const server = createServer(async (request, response) => {
  if (request.method === "POST") {
    const hash = createHash("sha256")
    let bytes = 0
    for await (const chunk of request) {
      bytes += chunk.length
      hash.update(chunk)
    }
    received.push({ bytes, hash: hash.digest("hex"), name: String(request.headers["x-filename"]) })
    response.writeHead(request.url === "/reject" ? 500 : 200)
    response.end("observed server result")
    return
  }
  response.setHeader("Content-Type", "text/html")
  response.end(`<input id="files" type="file" multiple><button id="submit">Submit</button><iframe src="/frame"></iframe><script>
    const input=document.querySelector('#files'); let changes=0;
    async function submit(){ for(const file of input.files) await fetch(location.pathname==='/reject'?'/reject':'/receive',{method:'POST',headers:{'x-filename':file.name},body:file}); }
    input.addEventListener('change',()=>{changes++;if(location.pathname==='/auto'||location.pathname==='/reject')submit()});
    document.querySelector('#submit').onclick=submit;
  </script>`)
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const address = server.address()
assert.ok(address && typeof address !== "string")
const url = `http://127.0.0.1:${address.port}`
const context = await chromium.launchPersistentContext(join(dir, "profile"), {
  executablePath: process.env.RAYA_TEST_BROWSER,
  headless: true,
})
const session = new BrowserSession(dir, async () => context as unknown as BrowserContextLike)
const origin = { requestID: "upload-request", sessionID: "task-1", directory: dir }
const until = async <T>(read: () => Promise<T | undefined>) => {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Upload condition timed out")
}
const block = Buffer.alloc(1024 * 1024, 42)
const hash = createHash("sha256")
const source = join(dir, "source")
const handle = await open(source, "wx")
for (let index = 0; index < 40; index++) {
  await handle.writeFile(block)
  hash.update(block)
}
await handle.close()
const file = { id: randomUUID(), name: "quarterly-report.csv", bytes: 40 * block.length, sha256: hash.digest("hex") }
const transport: UploadTransport = {
  chunk: async (_file, offset, signal) => {
    signal.throwIfAborted()
    const handle = await open(source, "r")
    try {
      const data = Buffer.alloc(Math.min(block.length, file.bytes - offset))
      await handle.read(data, 0, data.length, offset)
      return { data: data.toString("base64"), offset, next: offset + data.length }
    } finally {
      await handle.close()
    }
  },
  release: async () => undefined,
}
const inspect = async (id: string) => {
  const result = await session.execute({ operation: "upload", action: "inspect", uploadID: id, origin })
  assert.equal(result.operation, "upload")
  if (result.operation !== "upload") throw new Error("Unexpected operation")
  return result.uploads[0]
}
const terminal = (id: string) =>
  until(async () => {
    const info = await inspect(id)
    return ["staging", "selecting"].includes(info.status) ? undefined : info
  })
try {
  await session.ready()
  const tabID = (await session.inventory())[0].id
  await session.execute({ operation: "navigate", tabID, url: `${url}/`, origin })
  const start = {
    operation: "upload" as const,
    action: "start" as const,
    uploadID: randomUUID(),
    tabID,
    selector: "#files",
    destination: `${url}/`,
    origin,
    files: [file],
    uploader: transport,
  }
  const accepted = await session.execute(start)
  assert.equal(accepted.operation, "upload")
  const selected = await terminal(start.uploadID)
  assert.equal(selected.status, "selected", JSON.stringify(selected))
  assert.equal(received.length, 0, "selection must not pretend to submit a normal form")
  assert.equal(selected.files[0].selectedName, file.name)
  assert.equal((await readFile(join(dir, "raya-uploads", start.uploadID, file.id, file.name))).length, file.bytes)
  await session.execute(start)
  assert.equal(await context.pages()[0].evaluate("changes"), 1, "lost acknowledgement must not replay selection")
  await assert.rejects(
    session.execute({
      operation: "upload",
      action: "inspect",
      uploadID: start.uploadID,
      origin: { ...origin, sessionID: "other" },
    }),
    /another task/,
  )
  await assert.rejects(
    session.execute({ operation: "upload", action: "cancel", uploadID: start.uploadID, origin }),
    /already have submitted/,
  )
  await session.execute({ operation: "click", tabID, selector: "#submit", origin })
  await until(async () => (received.length === 1 ? true : undefined))
  assert.deepEqual(received[0], { bytes: file.bytes, hash: file.sha256, name: file.name })

  await session.execute({ operation: "navigate", tabID, url: `${url}/reject`, origin })
  const rejected = { ...start, uploadID: randomUUID(), destination: `${url}/reject` }
  await session.execute(rejected)
  assert.equal(
    (await terminal(rejected.uploadID)).status,
    "selected",
    "server rejection does not change selection into a false completed upload",
  )
  await until(async () => (received.length === 2 ? true : undefined))

  const gate = Promise.withResolvers<void>()
  const begun = Promise.withResolvers<void>()
  const waiting: UploadTransport = {
    ...transport,
    chunk: async (file, offset, signal) => {
      begun.resolve()
      await Promise.race([
        gate.promise,
        new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        ),
      ])
      return transport.chunk(file, offset, signal)
    },
  }
  const cancelled = { ...rejected, uploadID: randomUUID(), uploader: waiting }
  await session.execute(cancelled)
  await begun.promise
  const result = await session.execute({ operation: "upload", action: "cancel", uploadID: cancelled.uploadID, origin })
  assert.equal(result.operation, "upload")
  assert.equal((await inspect(cancelled.uploadID)).status, "cancelled")
  assert.equal(received.length, 2)
  gate.resolve()

  const pause = Promise.withResolvers<void>()
  const seen = Promise.withResolvers<void>()
  const stale = {
    ...rejected,
    uploadID: randomUUID(),
    uploader: {
      ...transport,
      chunk: async (...args: Parameters<UploadTransport["chunk"]>) => {
        seen.resolve()
        await pause.promise
        return transport.chunk(...args)
      },
    },
  }
  await session.execute(stale)
  await seen.promise
  await session.execute({ operation: "navigate", tabID, url: `${url}/`, origin })
  pause.resolve()
  const refused = await terminal(stale.uploadID)
  assert.equal(refused.status, "failed", JSON.stringify(refused))
  assert.equal(received.length, 2, "navigation while staging must not select into a new document")

  await assert.rejects(
    session.execute({ ...start, uploadID: randomUUID(), destination: `${url}/wrong` }),
    /destination changed/,
  )
  const tampered = { ...start, uploadID: randomUUID(), files: [{ ...file, sha256: "0".repeat(64) }] }
  await session.execute(tampered)
  assert.equal((await terminal(tampered.uploadID)).status, "failed")
  assert.equal(await context.pages()[0].evaluate("changes"), 0)

  const tree = await session.execute({ operation: "frames", action: "list", tabID })
  assert.equal(tree.operation, "frames")
  if (tree.operation !== "frames") throw new Error("Unexpected frame result")
  const frame = tree.frames.find((frame) => !frame.main && frame.url === `${url}/frame`)
  assert.ok(frame)
  const empty = { id: randomUUID(), name: "../../empty.txt", bytes: 0, sha256: createHash("sha256").digest("hex") }
  const framed = {
    ...start,
    uploadID: randomUUID(),
    frameID: frame.id,
    destination: `${url}/frame`,
    files: [file, empty],
  }
  await session.execute(framed)
  const multiple = await terminal(framed.uploadID)
  assert.equal(multiple.status, "selected", JSON.stringify(multiple))
  assert.equal(multiple.files[1].selectedName, ".._.._empty.txt")
  assert.equal(await context.pages()[0].evaluate("changes"), 0, "frame upload must not select the main-document input")
  await session.execute({ operation: "click", tabID, frameID: frame.id, selector: "#submit", origin })
  await until(async () => (received.length === 4 ? true : undefined))
  assert.deepEqual(received.slice(2), [
    { bytes: file.bytes, hash: file.sha256, name: file.name },
    { bytes: 0, hash: empty.sha256, name: ".._.._empty.txt" },
  ])

  await session.dispose()
  const restored = new BrowserUploads(join(dir, "raya-uploads"))
  const records = await restored.list(origin, start.uploadID)
  assert.equal(records[0].status, "selected")
  await assert.rejects(readFile(join(dir, "raya-uploads", start.uploadID, file.id, file.name)), /ENOENT/)
  const unknown: UploadInfo = { ...selected, id: randomUUID(), status: "selecting" }
  const receipt = join(dir, "raya-uploads", unknown.id, "receipt.json")
  await import("node:fs/promises").then(({ mkdir }) => mkdir(join(dir, "raya-uploads", unknown.id)))
  await writeFile(receipt, JSON.stringify(unknown))
  const restarted = new BrowserUploads(join(dir, "raya-uploads"))
  assert.equal((await restarted.list(origin, unknown.id))[0].status, "unknown")
} finally {
  await session.dispose()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
}
