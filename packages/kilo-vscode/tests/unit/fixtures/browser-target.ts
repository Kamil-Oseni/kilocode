import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium } from "playwright-core"
import { BrowserSession, type BrowserContextLike } from "../../../src/services/browser-automation/browser-session"
import { BrowserSmoke } from "../../../src/services/browser-automation/browser-smoke"
import { locate, type BrowserTarget, type TargetPage } from "../../../src/services/browser-automation/browser-target"

const binary = process.env.RAYA_TEST_BROWSER ?? chromium.executablePath()

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "raya-target-"))
  const context = await chromium.launchPersistentContext(dir, {
    executablePath: binary,
    headless: true,
    timeout: 10_000,
  })
  const page = context.pages()[0] ?? (await context.newPage())
  const session = new BrowserSession(dir, async () => context as unknown as BrowserContextLike)
  try {
    await page.setContent(`
      <section id="first"><button onclick="this.textContent='Saved first'">Save</button></section>
      <section id="second"><button onclick="this.textContent='Saved second'">Save</button></section>
      <button onclick="this.textContent='Wrong'">Save copy</button>
      <label>Name<input id="name"></label><label>Name extra<input id="extra"></label>
      <label for="choice">Choice</label><select id="choice"><option value="a">A</option><option value="b">B</option></select>
      <div data-testid="result">Ready</div>
      <button id="legacy" onclick="document.querySelector('[data-testid=result]').textContent='Done'">Finish</button>
    `)
    await session.ready()
    const host = page as unknown as TargetPage
    const attempts: number[] = []
    const off = session.onState((state) => {
      if (state.attempts !== undefined) attempts.push(state.attempts)
    })
    await assert.rejects(
      session.execute({ operation: "click", selector: { kind: "role", role: "button", name: "Save" } }),
      /matched 2/,
    )
    off()
    assert.equal(Math.max(...attempts), 1)
    await assert.rejects(locate(host, { kind: "role", role: "button", name: "Save" }), new RegExp("matched 2"))
    await assert.rejects(
      locate(host, { kind: "role", role: "button", name: "Save", scope: "section" }),
      new RegExp("scope matched 2"),
    )
    await assert.rejects(locate(host, { kind: "testid", value: "missing" }), new RegExp("matched 0"))
    for (const target of [
      { kind: "role", role: "button" },
      { kind: "label", text: "" },
      { kind: "other", value: "result" },
      { kind: "testid", value: "result", extra: true },
    ])
      await assert.rejects(locate(host, target as BrowserTarget), new RegExp("Invalid browser semantic target"))
    assert.equal(await page.getByRole("button", { name: "Save", exact: true }).count(), 2)
    await session.execute({
      operation: "click",
      selector: { kind: "role", role: "button", name: "Save", scope: "#second" },
    })
    assert.equal(await page.locator("#second button").textContent(), "Saved second")
    assert.equal(await page.locator("#first button").textContent(), "Save")
    assert.equal(await page.getByRole("button", { name: "Save copy", exact: true }).textContent(), "Save copy")
    await session.execute({ operation: "type", selector: { kind: "label", text: "Name" }, text: "Ada", submit: false })
    assert.equal(await page.locator("#name").inputValue(), "Ada")
    assert.equal(await page.locator("#extra").inputValue(), "")
    await session.execute({ operation: "select", selector: { kind: "label", text: "Choice" }, values: ["b"] })
    assert.equal(await page.locator("select").inputValue(), "b")
    await session.execute({ operation: "click", selector: "#legacy" })
    assert.equal(await page.getByTestId("result").textContent(), "Done")
    await page.getByTestId("result").evaluate((element) => {
      element.textContent = "Ready"
    })
    const smoke = new BrowserSmoke(join(dir, "artifacts"), page, context)
    const report = await smoke.run({
      name: "semantic",
      mode: "scripted",
      steps: [
        {
          id: "finish",
          title: "Finish saved form",
          action: { kind: "click", selector: { kind: "role", role: "button", name: "Finish" } },
          assertions: [
            { kind: "visible", selector: { kind: "testid", value: "result" }, text: "Done" },
            { kind: "console", level: "error", max: 0 },
          ],
        },
      ],
    })
    assert.equal(report.passed, true)
    assert.ok(report.steps[0].assertions[0].expected.includes('"kind":"testid"'))
    await page.setContent("<button>Duplicate</button><button>Duplicate</button>")
    const failed = await smoke.run({
      name: "semantic",
      mode: "scripted",
      steps: [
        {
          id: "ambiguous",
          title: "Reject ambiguous assertion",
          assertions: [
            { kind: "visible", selector: { kind: "role", role: "button", name: "Duplicate" } },
            { kind: "console", level: "error", max: 0 },
          ],
        },
      ],
    })
    assert.equal(failed.passed, false)
    assert.ok(failed.steps[0].error?.includes("matched 2"))
    for (const expression of [
      '(() => { globalThis.__raya_effects++; throw new Error("after mutation") })',
      'globalThis.__raya_effects++; throw new Error("Target closed after mutation")',
      'globalThis.__raya_effects++; throw new SyntaxError("runtime syntax error")',
      'globalThis.__raya_effects++; await Promise.reject(new Error("async failure")); return 1',
    ]) {
      await page.evaluate(() => Reflect.set(globalThis, "__raya_effects", 0))
      await assert.rejects(session.execute({ operation: "evaluate", expression }), /may have taken effect/)
      assert.equal(await page.evaluate(() => Reflect.get(globalThis, "__raya_effects")), 1)
      assert.equal(context.pages().length, 1)
    }
    await page.evaluate(() => Reflect.set(globalThis, "__raya_effects", 0))
    await assert.rejects(
      session.execute({ operation: "evaluate", expression: "globalThis.__raya_effects++; ???" }),
      /not dispatched/,
    )
    assert.equal(await page.evaluate(() => Reflect.get(globalThis, "__raya_effects")), 0)
    for (const [expression, output] of [
      ["const n = 2; n * 3", "6"],
      ["{ ok: true }", '{"ok":true}'],
      ["() => ({ ok: true })", '{"ok":true}'],
      ["const n = await Promise.resolve(4); return n", "4"],
    ]) {
      const result = await session.execute({ operation: "evaluate", expression })
      assert.ok("output" in result)
      assert.equal(result.output, output)
    }
    await page.setContent(
      '<button onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks || 0)+1)">Commit</button>',
    )
    const title = page.title.bind(page)
    page.title = async () => {
      throw new Error("result observation channel failed")
    }
    try {
      await assert.rejects(
        session.execute({ operation: "click", selector: { kind: "role", role: "button", name: "Commit" } }),
        /may have taken effect/,
      )
    } finally {
      page.title = title
    }
    assert.equal(await page.evaluate(() => document.body.dataset.clicks), "1")
    assert.equal(context.pages().length, 1)
    await page.setContent(
      '<button onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks || 0)+1)">Commit</button><button>Duplicate</button><button>Duplicate</button>',
    )
    const incomplete = await session.execute({
      operation: "smoke",
      name: "once-smoke",
      mode: "scripted",
      steps: [
        {
          id: "commit",
          title: "Commit once",
          action: { kind: "click", selector: { kind: "role", role: "button", name: "Commit" } },
          assertions: [
            { kind: "visible", selector: "body", text: "Commit" },
            { kind: "console", level: "error", max: 0 },
          ],
        },
        {
          id: "ambiguous",
          title: "Reject next ambiguous target",
          action: { kind: "click", selector: { kind: "role", role: "button", name: "Duplicate" } },
          assertions: [{ kind: "visible", selector: "body" }],
        },
      ],
    })
    assert.equal(incomplete.operation, "smoke")
    assert.ok("passed" in incomplete)
    assert.equal(incomplete.passed, false)
    assert.equal(await page.evaluate(() => document.body.dataset.clicks), "1")

    const original = (await session.inventory())[0].id
    await page.setContent(
      "<button onclick=\"window.open('about:blank')\">Popup</button><button onclick=\"document.body.dataset.saved='yes'\">Save</button>",
    )
    const pending = context.waitForEvent("page")
    await session.execute({
      operation: "click",
      tabID: original,
      selector: { kind: "role", role: "button", name: "Popup" },
    })
    const popup = await pending
    await popup.waitForLoadState()
    const inventory = await session.inventory()
    const child = inventory.find((tab) => tab.id !== original)!
    assert.equal(child.openerID, original)
    assert.equal(child.selected, false)
    assert.equal(inventory.find((tab) => tab.id === original)?.selected, true)
    await assert.rejects(session.execute({ operation: "click", selector: "button" }), /observed tab ID/)
    await session.tab("select", child.id)
    await assert.rejects(
      session.pointer({ type: "mousePressed", x: 0.5, y: 0.5 }, original),
      /displayed browser tab changed/,
    )
    const saved = await session.execute({
      operation: "click",
      tabID: original,
      selector: { kind: "role", role: "button", name: "Save" },
    })
    assert.equal(saved.tabID, original)
    assert.equal(await page.evaluate(() => document.body.dataset.saved), "yes")
    assert.equal((await session.inventory()).find((tab) => tab.id === child.id)?.selected, true)
    const observed = await session.execute({ operation: "snapshot", tabID: original })
    assert.equal(observed.tabID, original)
    const parent = context.waitForEvent("page")
    await popup.evaluate(() => window.open("about:blank"))
    const descendant = await parent
    await descendant.waitForLoadState()
    const owned = (await session.inventory()).find((tab) => tab.openerID === child.id)!
    assert.ok(owned)
    await session.execute({ operation: "tabs", action: "close", tabID: child.id })
    assert.equal((await session.inventory()).find((tab) => tab.id === owned.id)?.openerID, child.id)
    await session.execute({ operation: "tabs", action: "close", tabID: owned.id })
    await assert.rejects(
      session.execute({ operation: "evaluate", tabID: child.id, expression: "1" }),
      /closed or unknown/,
    )
    await assert.rejects(session.execute({ operation: "snapshot", tabID: child.id }), /closed or unknown/)
    await assert.rejects(session.execute({ operation: "snapshot" }), /observed tab ID/)
    assert.equal(context.pages().length, 1)
    await session.execute({ operation: "tabs", action: "open", url: "about:blank" })
    const opened = (await session.inventory()).find((tab) => tab.selected)!
    assert.notEqual(opened.id, child.id)
    const blocker = session.execute({
      operation: "evaluate",
      tabID: opened.id,
      expression: "new Promise(resolve => setTimeout(() => resolve(1), 200))",
    })
    const waiting = session.execute({ operation: "click", tabID: original, selector: "button" }).then(
      () => "unexpected dispatch",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    await page.close()
    await blocker
    assert.match(await waiting, /closed or unknown/)
    assert.equal(context.pages().length, 1)
    await session.execute({ operation: "tabs", action: "close", tabID: opened.id })
    await assert.rejects(session.execute({ operation: "tabs", action: "close", tabID: original }), /closed or unknown/)
    assert.deepEqual(await session.inventory(), [])
    await session.execute({ operation: "tabs", action: "open", url: "about:blank" })
    assert.equal((await session.inventory()).length, 1)
    await assert.rejects(session.execute({ operation: "snapshot", tabID: original }), /closed or unknown/)
  } finally {
    await session.dispose()
    await context.close()
    await rm(dir, { recursive: true, force: true })
  }
}

await main()
