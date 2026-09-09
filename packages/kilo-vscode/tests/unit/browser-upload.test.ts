import { expect, test } from "bun:test"
import { existsSync, rmdirSync } from "node:fs"
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { chromium } from "playwright-core"
import { BrowserUploads } from "../../src/services/browser-automation/browser-upload"

test("closing during receipt admission waits for cleanup before replacement restore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raya-upload-close-"))
  const uploads = new BrowserUploads(dir)
  const gate = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  let closed = false
  let closing: Promise<void> | undefined
  try {
    const id = randomUUID()
    const file = { id: randomUUID(), name: "empty.txt", bytes: 0, sha256: createHash("sha256").digest("hex") }
    const origin = { requestID: "request", sessionID: "task", directory: dir }
    uploads.onChange(() => {
      uploads.stop()
      closing = uploads.close().then(() => {
        closed = true
      })
    })
    const starting = uploads.start(
      { id, tabID: "observed", origin, destination: "https://example.test", files: [file] },
      {
        chunk: async () => {
          throw new Error("Disposed upload must not fetch bytes")
        },
        release: async () => {
          released.resolve()
          await gate.promise
        },
      },
      async () => {
        throw new Error("Disposed upload must not select files")
      },
      async () => undefined,
    )
    await released.promise
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(closed).toBe(false)
    gate.resolve()
    await starting
    await closing
    expect(closed).toBe(true)
    const restored = new BrowserUploads(dir)
    expect((await restored.list(origin, id))[0].status).toBe("unknown")
    await restored.close()
  } finally {
    gate.resolve()
    await uploads.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("receipt failure after native selection remains unknown after persistence recovers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raya-upload-receipt-"))
  const uploads = new BrowserUploads(dir)
  try {
    const id = randomUUID()
    const file = {
      id: randomUUID(),
      name: "report.txt",
      bytes: 1,
      sha256: createHash("sha256").update("x").digest("hex"),
    }
    const origin = { requestID: "request", sessionID: "task", directory: dir }
    const receipt = join(dir, id, "receipt.json")
    let events = 0
    let selections = 0
    const recovered = Promise.withResolvers<void>()
    uploads.onChange(() => {
      events++
      if (events === 3) rmdirSync(receipt)
      if (events === 4) recovered.resolve()
    })
    const input = { id, tabID: "observed-tab", origin, destination: "https://example.test/form", files: [file] }
    const transport = { chunk: async () => ({ data: "eA==", offset: 0, next: 1 }), release: async () => undefined }
    await uploads.start(
      input,
      transport,
      async (_files, _signal, dispatch) => {
        await dispatch()
        selections++
        await unlink(receipt)
        await mkdir(receipt)
      },
      async () => undefined,
    )
    await recovered.promise
    expect((await uploads.list(origin, id))[0].status).toBe("unknown")
    await uploads.start(
      input,
      transport,
      async () => {
        selections++
      },
      async () => undefined,
    )
    expect(selections).toBe(1)
    expect(await Bun.file(join(dir, id, file.id, file.name)).text()).toBe("x")
  } finally {
    uploads.stop()
    await uploads.close()
    await rm(dir, { recursive: true, force: true })
  }
})

const binary = process.env.RAYA_TEST_BROWSER ?? chromium.executablePath()
const browser = existsSync(binary) ? test : test.skip
browser(
  "real uploads retain identity, verified bytes, ownership and honest selection outcomes",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "raya-upload-test-"))
    try {
      const output = await Bun.build({
        entrypoints: [join(import.meta.dir, "fixtures/browser-upload.ts")],
        target: "node",
        format: "esm",
        external: ["playwright-core"],
      })
      expect(output.success).toBe(true)
      const file = join(dir, "fixture.mjs")
      const module = pathToFileURL(Bun.resolveSync("playwright-core", import.meta.dir)).href
      await writeFile(file, (await output.outputs[0].text()).replaceAll('"playwright-core"', JSON.stringify(module)))
      const child = Bun.spawn(["node", file], {
        env: { ...process.env, RAYA_TEST_BROWSER: binary },
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`Upload fixture exited ${code}: ${stdout}\n${stderr}`)
      expect(code).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
  60000,
)
