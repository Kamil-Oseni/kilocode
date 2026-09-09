import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium } from "playwright-core"
import { BrowserSession, type BrowserContextLike } from "../../../src/services/browser-automation/browser-session"

const form = `<label>Name<input></label><button onclick="document.body.dataset.saved='yes'">Save</button><select aria-label="Choice"><option>A</option><option>B</option></select><p>Frame content</p>`
const remote = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html")
  response.end(form)
})
await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve))
const address = remote.address()
assert.ok(address && typeof address !== "string")
const cross = `http://127.0.0.1:${address.port}`
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html")
  response.end(
    request.url === "/"
      ? `${form}<iframe id="same" src="/form"></iframe><iframe id="cross" src="${cross}/form"></iframe>`
      : `${form}${request.url?.startsWith("/form") ? '<iframe id="nested" src="/nested"></iframe>' : ""}`,
  )
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const local = server.address()
assert.ok(local && typeof local !== "string")
const origin = `http://127.0.0.1:${local.port}`
const dir = await mkdtemp(join(tmpdir(), "raya-frames-"))
const context = await chromium.launchPersistentContext(dir, {
  executablePath: process.env.RAYA_TEST_BROWSER,
  headless: true,
})
const page = context.pages()[0]
const session = new BrowserSession(dir, async () => context as unknown as BrowserContextLike)
try {
  await page.goto(origin)
  await session.ready()
  const tabID = (await session.inventory())[0].id
  const tree = async () => {
    const result = await session.execute({ operation: "frames", action: "list", tabID })
    assert.equal(result.operation, "frames")
    assert.ok("frames" in result)
    return result.frames
  }
  const main = (await tree()).find((frame) => frame.main)!.id
  const resolve = async (parentID: string, selector: string) => {
    const result = await session.execute({ operation: "frames", action: "resolve", tabID, parentID, selector })
    assert.ok("frames" in result)
    return result.frames[0].id
  }
  await assert.rejects(resolve(main, "iframe"), /exactly one/)
  await assert.rejects(resolve(main, "button"), /direct child iframe/)
  const same = await resolve(main, "#same")
  const foreign = await resolve(main, "#cross")
  const nested = await resolve(same, "#nested")
  const snapshot = await session.execute({ operation: "snapshot", tabID, frameID: foreign })
  assert.equal(snapshot.frameID, foreign)
  assert.equal(snapshot.frameURL, `${cross}/form`)
  assert.ok("snapshot" in snapshot && snapshot.snapshot?.includes("Frame content"))
  await session.execute({
    operation: "click",
    tabID,
    frameID: same,
    selector: { kind: "role", role: "button", name: "Save" },
  })
  assert.equal(await page.evaluate(() => document.body.dataset.saved), undefined)
  assert.equal(await page.frameLocator("#same").locator("body").getAttribute("data-saved"), "yes")
  assert.equal(await page.frameLocator("#cross").locator("body").getAttribute("data-saved"), null)
  await session.execute({
    operation: "type",
    tabID,
    frameID: foreign,
    selector: { kind: "label", text: "Name" },
    text: "Cross origin",
    submit: false,
  })
  assert.equal(await page.frameLocator("#cross").getByLabel("Name").inputValue(), "Cross origin")
  await session.execute({
    operation: "select",
    tabID,
    frameID: nested,
    selector: { kind: "label", text: "Choice" },
    values: ["B"],
  })
  assert.equal(await page.frameLocator("#same").frameLocator("#nested").getByLabel("Choice").inputValue(), "B")
  const report = await session.execute({
    operation: "smoke",
    tabID,
    name: "frames",
    mode: "scripted",
    steps: [
      {
        id: "save",
        title: "Save in cross-origin frame",
        action: { kind: "click", frameID: foreign, selector: { kind: "role", role: "button", name: "Save" } },
        assertions: [
          { kind: "visible", frameID: foreign, selector: "p", text: "Frame content" },
          { kind: "console", level: "error", max: 0 },
        ],
      },
    ],
  })
  assert.ok("passed" in report && report.passed)
  assert.equal(report.steps[0].screenshotScope, "tab")
  assert.equal(report.steps[0].assertions[0].frameID, foreign)
  assert.equal(report.steps[0].assertions[1].scope, "tab")
  await page.locator("#same").evaluate((element) => {
    element.outerHTML = element.outerHTML
  })
  await page.frameLocator("#same").getByRole("button").waitFor()
  await assert.rejects(session.execute({ operation: "click", tabID, frameID: same, selector: "button" }), /stale/)
  await assert.rejects(session.execute({ operation: "snapshot", tabID, frameID: nested }), /stale/)
  const replacement = await resolve(main, "#same")
  assert.notEqual(replacement, same)
  const frame = page.frames().find((frame) => frame.url() === `${origin}/form`)!
  await frame.goto(`${origin}/form?new`)
  await assert.rejects(
    session.execute({
      operation: "evaluate",
      tabID,
      frameID: replacement,
      expression: "document.body.dataset.saved='wrong'",
    }),
    /stale/,
  )
  assert.equal(await frame.evaluate(() => document.body.dataset.saved), undefined)
  const current = await resolve(main, "#same")
  const locator = frame.locator.bind(frame)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  frame.locator = (...args) => {
    const result = locator(...args)
    const handle = result.elementHandle.bind(result)
    result.elementHandle = async (...options) => {
      const element = await handle(...options)
      entered.resolve()
      await release.promise
      return element
    }
    return result
  }
  const racing = session.execute({ operation: "click", tabID, frameID: current, selector: "button" }).then(
    () => "unexpected success",
    (error: unknown) => String(error),
  )
  await entered.promise
  await frame.goto(`${origin}/form?race`)
  release.resolve()
  assert.match(await racing, /stale/)
  frame.locator = locator
  assert.equal(await frame.evaluate(() => document.body.dataset.saved), undefined)
  const blocked = await resolve(main, "#same")
  await frame.getByRole("button").evaluate((element: HTMLButtonElement) => {
    element.disabled = true
  })
  const dispatched = Promise.withResolvers<void>()
  frame.locator = (...args) => {
    const result = locator(...args)
    const handle = result.elementHandle.bind(result)
    result.elementHandle = async (...options) => {
      const element = await handle(...options)
      if (element) {
        const click = element.click.bind(element)
        element.click = (...options) => {
          const pending = click(...options)
          dispatched.resolve()
          return pending
        }
      }
      return element
    }
    return result
  }
  const mutation = session.execute({ operation: "click", tabID, frameID: blocked, selector: "button" }).then(
    () => "unexpected success",
    (error: unknown) => String(error),
  )
  await dispatched.promise
  await frame.goto(`${origin}/form?dispatched`)
  assert.match(await mutation, /may have taken effect/)
  frame.locator = locator
  assert.equal(await frame.evaluate(() => document.body.dataset.saved), undefined)
  const queuedID = await resolve(main, "#same")
  const blocker = session.execute({
    operation: "evaluate",
    tabID,
    frameID: foreign,
    expression: "new Promise(resolve => setTimeout(() => resolve(1), 200))",
  })
  const queued = session.execute({ operation: "click", tabID, frameID: queuedID, selector: "button" }).then(
    () => "unexpected dispatch",
    (error: unknown) => String(error),
  )
  await frame.goto(`${origin}/form?queued`)
  await blocker
  assert.match(await queued, /stale/)
  assert.equal(await frame.evaluate(() => document.body.dataset.saved), undefined)
  const fresh = await resolve(main, "#same")
  const captured = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  frame.locator = (...args) => {
    const result = locator(...args)
    const snapshot = result.ariaSnapshot.bind(result)
    result.ariaSnapshot = async (...options) => {
      const text = await snapshot(...options)
      captured.resolve()
      await resume.promise
      return text
    }
    return result
  }
  const reading = session.execute({ operation: "snapshot", tabID, frameID: fresh }).then(
    () => "unexpected snapshot",
    (error: unknown) => String(error),
  )
  await captured.promise
  await frame.goto(`${origin}/form?observation`)
  resume.resolve()
  assert.match(await reading, /stale/)
  frame.locator = locator
  await assert.rejects(
    session.execute({ operation: "screenshot", tabID, frameID: fresh, fullPage: false }),
    /tab-scoped/,
  )
  const other = await context.newPage()
  const otherID = (await session.inventory()).find((tab) => tab.id !== tabID)!.id
  await assert.rejects(session.execute({ operation: "snapshot", tabID: otherID, frameID: main }), /another tab/)
  await other.close()
} finally {
  await session.dispose()
  await context.close()
  await Promise.all([
    new Promise<void>((resolve) => server.close(() => resolve())),
    new Promise<void>((resolve) => remote.close(() => resolve())),
  ])
  await rm(dir, { recursive: true, force: true })
}
