import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, type BrowserContext } from "playwright-core"
import { BrowserSession, type BrowserContextLike } from "../../../src/services/browser-automation/browser-session"
import { BrowserAuth } from "../../../src/services/browser-automation/browser-auth"
import { profile } from "../../../src/services/browser-automation/browser-profile"

const dir = await mkdtemp(join(tmpdir(), "raya-profiles-"))
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html")
  response.end("<h1>Account</h1><p>Inspect the signed-in account before continuing.</p>")
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const address = server.address()
assert.ok(address && typeof address !== "string")
const url = `http://127.0.0.1:${address.port}`
const contexts: BrowserContext[] = []
let pause: Promise<void> | undefined
let entered: (() => void) | undefined
const launch = async (root: string) => {
  entered?.()
  await pause
  const context = await chromium.launchPersistentContext(join(root, "chromium"), {
    executablePath: process.env.RAYA_TEST_BROWSER,
    headless: true,
  })
  contexts.push(context)
  return context as unknown as BrowserContextLike
}
const owned = await profile(join(dir, "profiles"), dir)
await mkdir(join(dir, "other"))
const foreign = await profile(join(dir, "profiles"), join(dir, "other"))
const session = new BrowserSession(owned.path, launch, join(owned.path, "artifacts"), owned.owner)
const other = new BrowserSession(foreign.path, launch, join(foreign.path, "artifacts"), foreign.owner)
const tab = async (value = session) => (await value.inventory())[0].id
const visit = async (value = session) => {
  await value.execute({ operation: "navigate", tabID: await tab(value), url })
  return contexts.at(-1)!.pages()[0]
}
try {
  await session.ready()
  const page = await visit()
  await page.evaluate(async () => {
    document.cookie = "login=captured-secret; path=/; max-age=3600"
    document.cookie = "session=temporary-secret; path=/"
    localStorage.setItem("identity", "captured-account")
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("identity", 1)
      request.onupgradeneeded = () => request.result.createObjectStore("values")
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const transaction = request.result.transaction("values", "readwrite")
        transaction.objectStore("values").put("captured-indexed-account", "account")
        transaction.oncomplete = () => {
          request.result.close()
          resolve()
        }
      }
    })
  })
  const original = await tab()
  const result = await session.execute({ operation: "auth_capture", name: "Account A", tabID: original })
  assert.equal(result.operation, "auth_capture")
  if (result.operation !== "auth_capture") throw new Error("Missing capture")
  const capture = result.capture
  assert.ok(!JSON.stringify(result).includes("captured-secret"))
  assert.ok(capture.domains.includes("127.0.0.1"))
  await other.ready()
  const unrelated = await visit(other)
  assert.equal(await unrelated.evaluate("document.cookie"), "")
  await assert.rejects(
    other.execute({ operation: "auth", action: "restore", profileID: owned.owner.profileID, captureID: capture.id }),
    /does not match/,
  )
  await assert.rejects(
    other.execute({ operation: "auth", action: "restore", profileID: foreign.owner.profileID, captureID: capture.id }),
    /ENOENT/,
  )
  await page.evaluate(() => {
    document.cookie = "login=other-secret; path=/"
    localStorage.setItem("identity", "other-account")
  })
  await session.execute({
    operation: "auth",
    action: "restore",
    profileID: owned.owner.profileID,
    captureID: capture.id,
  })
  assert.notEqual(await tab(), original)
  await assert.rejects(
    session.execute({ operation: "click", tabID: original, selector: "h1" }),
    /unknown|closed|identity/i,
  )
  const restored = await visit()
  assert.ok(
    ((await restored.evaluate("document.cookie")) as string).includes("login=captured-secret"),
    "explicit restore replaces the previous persistent account cookie",
  )
  assert.ok(
    ((await restored.evaluate("document.cookie")) as string).includes("session=temporary-secret"),
    "explicit restore includes session-only cookies",
  )
  assert.equal(await restored.evaluate("localStorage.getItem('identity')"), "captured-account")
  assert.equal(
    await restored.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open("identity", 1)
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const value = request.result.transaction("values").objectStore("values").get("account")
            value.onsuccess = () => {
              request.result.close()
              resolve(value.result)
            }
          }
        }),
    ),
    "captured-indexed-account",
  )
  assert.equal(session.profileState().authentication.captureID, capture.id)
  await session.dispose()
  await session.ready()
  assert.equal(session.profileState().authentication.source, "capture")
  const restarted = await visit()
  assert.equal(
    await restarted.evaluate("document.cookie"),
    "login=captured-secret",
    "restart preserves native persistent cookies without secretly replaying session cookies from the capture",
  )
  assert.equal(session.profileState().authentication.login, "unverified")
  const report = await session.execute({
    operation: "smoke",
    tabID: await tab(),
    name: "Uses current profile",
    mode: "scripted",
    steps: [
      {
        id: "account",
        title: "Account state",
        assertions: [
          { kind: "visible", selector: "h1", text: "Account" },
          { kind: "console", level: "error", max: 0 },
        ],
      },
    ],
  })
  assert.equal(report.operation, "smoke")
  if (report.operation !== "smoke") throw new Error("Missing smoke report")
  assert.equal(report.authentication.captureID, capture.id)
  assert.equal(report.authentication.login, "unverified")
  assert.ok(!JSON.stringify(report).includes("captured-secret"))
  const preserved = join(owned.path, "raya-downloads", "retained-artifact")
  await writeFile(preserved, "retained bytes")
  const rival = new BrowserSession(owned.path, launch, join(owned.path, "artifacts"), owned.owner)
  try {
    await assert.rejects(
      rival.execute({ operation: "auth", action: "delete", profileID: owned.owner.profileID, captureID: capture.id }),
      /profile is in use/,
    )
  } finally {
    await rival.dispose()
  }
  await session.dispose()
  const deleting = new BrowserSession(owned.path, launch, join(owned.path, "artifacts"), owned.owner)
  try {
    await deleting.execute({
      operation: "auth",
      action: "delete",
      profileID: owned.owner.profileID,
      captureID: capture.id,
    })
  } finally {
    await deleting.dispose()
  }
  assert.equal(await readFile(preserved, "utf8"), "retained bytes")
  await session.ready()
  const signedout = await visit()
  assert.equal(session.profileState().authentication.source, "live")
  assert.equal(await signedout.evaluate("document.cookie"), "")
  assert.equal(await signedout.evaluate("localStorage.getItem('identity')"), null)
  await assert.rejects(
    session.execute({ operation: "auth", action: "restore", profileID: owned.owner.profileID, captureID: capture.id }),
    /ENOENT/,
  )

  const auth = new BrowserAuth(join(owned.path, "auth"), owned.owner)
  const fresh = await auth.capture("Expiring", { cookies: [], origins: [] })
  const receipt = join(owned.path, "auth", `${fresh.id}.json`)
  await writeFile(receipt, JSON.stringify({ ...fresh, expiresAt: Date.now() + 750 }))
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  pause = gate.promise
  entered = started.resolve
  const restoring = session.execute({
    operation: "auth",
    action: "restore",
    profileID: owned.owner.profileID,
    captureID: fresh.id,
  })
  void restoring.catch(() => undefined)
  await started.promise
  await new Promise((resolve) => setTimeout(resolve, 900))
  gate.resolve()
  await assert.rejects(restoring, /expired before restoration/)
  pause = undefined
  entered = undefined
  await session.dispose()
  const attempts = contexts.length
  await assert.rejects(session.ready(), /not confirmed/)
  assert.equal(contexts.length, attempts, "restart must refuse restoring intent before launching a profile")
  await session.execute({ operation: "profile", action: "reset", profileID: owned.owner.profileID })
  assert.equal(await readFile(preserved, "utf8"), "retained bytes")
  assert.equal((await auth.list()).length, 0)

  const external = await chromium.launchPersistentContext(join(owned.path, "chromium"), {
    executablePath: process.env.RAYA_TEST_BROWSER,
    headless: true,
  })
  try {
    await assert.rejects(session.execute({ operation: "profile", action: "reset", profileID: owned.owner.profileID }))
    assert.equal(await readFile(preserved, "utf8"), "retained bytes")
  } finally {
    await external.close()
  }
  await session.ready()
  const locked = new BrowserSession(owned.path, launch, join(owned.path, "artifacts"), owned.owner)
  try {
    await assert.rejects(locked.ready(), /profile is in use/)
    assert.equal(locked.profileState().status, "locked")
  } finally {
    await locked.dispose()
  }
} finally {
  pause = undefined
  await session.dispose()
  await other.dispose()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
}
