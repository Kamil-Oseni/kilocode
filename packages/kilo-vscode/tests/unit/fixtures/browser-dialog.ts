import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium } from "playwright-core"
import { BrowserSession, type BrowserContextLike } from "../../../src/services/browser-automation/browser-session"

const dir = await mkdtemp(join(tmpdir(), "raya-dialogs-"))
const context = await chromium.launchPersistentContext(dir, {
  executablePath: process.env.RAYA_TEST_BROWSER,
  headless: true,
})
const page = context.pages()[0]
const session = new BrowserSession(dir, async () => context as unknown as BrowserContextLike)
const until = async <T>(read: () => Promise<T | undefined>): Promise<T> => {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const result = await read()
    if (result !== undefined) return result
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Dialog condition did not settle within five seconds")
}
try {
  await page.setContent("<button>Activate</button>")
  await session.ready()
  const tabID = (await session.inventory())[0].id
  const list = async (operationID?: string) => {
    const state = await session.execute({ operation: "dialog", action: "list", tabID, operationID })
    assert.ok("dialogs" in state)
    return state
  }
  const pending = async (expression: string) => {
    await assert.rejects(
      session.execute({ operation: "evaluate", tabID, expression }),
      /remains pending and must not be retried/,
    )
    const dialog = (await list()).dialogs.find((dialog) => dialog.status === "open")!
    assert.ok(dialog)
    assert.ok(dialog.operationID)
    assert.equal((await list(dialog.operationID)).operations[0].status, "pending")
    return dialog
  }
  const finished = (id: string) =>
    until(async () => {
      const operation = (await list(id)).operations[0]
      return operation.status === "pending" ? undefined : operation
    })
  for (let index = 0; index < 1030; index++)
    await session.execute({ operation: "evaluate", tabID, expression: "1" })
  assert.equal((await list()).operations.length, 0)
  const alert = await pending('alert("Review <script>untrusted</script>"); "acknowledged"')
  assert.equal(alert.type, "alert")
  assert.equal(alert.message, "Review <script>untrusted</script>")
  await assert.rejects(
    session.execute({ operation: "evaluate", tabID, expression: "globalThis.wrong=1" }),
    /remains pending/,
  )
  await assert.rejects(session.navigate("about:blank", tabID), /remains pending/)
  await assert.rejects(
    session.execute({ operation: "dialog", action: "accept", tabID: "wrong", dialogID: alert.id }),
    /another tab/,
  )
  await assert.rejects(
    session.execute({ operation: "dialog", action: "invalid" as "accept", tabID, dialogID: alert.id }),
    /must be accept or dismiss/,
  )
  assert.equal((await list()).dialogs.find((item) => item.id === alert.id)?.status, "open")
  await session.execute({ operation: "dialog", action: "accept", tabID, dialogID: alert.id })
  const complete = await finished(alert.operationID!)
  assert.equal(complete.status, "completed")
  assert.match(complete.output!, /acknowledged/)
  await assert.rejects(
    session.execute({ operation: "dialog", action: "accept", tabID, dialogID: alert.id }),
    /already claimed/,
  )
  const confirm = await pending('globalThis.effects = confirm("Commit once?") ? 1 : 0; "confirmed"')
  await assert.rejects(
    session.execute({ operation: "dialog", action: "accept", tabID, dialogID: confirm.id, text: "invalid" }),
    /only for accepting a prompt/,
  )
  assert.equal((await list()).dialogs.find((dialog) => dialog.id === confirm.id)?.status, "open")
  await session.execute({ operation: "dialog", action: "dismiss", tabID, dialogID: confirm.id })
  assert.equal((await finished(confirm.operationID!)).status, "completed")
  assert.equal(await page.evaluate(() => Reflect.get(globalThis, "effects")), 0)
  const prompt = await pending('globalThis.answer = prompt("Name?", "Default"); "prompted"')
  assert.equal(prompt.defaultValue, "Default")
  await session.execute({ operation: "dialog", action: "accept", tabID, dialogID: prompt.id, text: "Ada" })
  await finished(prompt.operationID!)
  assert.equal(await page.evaluate(() => Reflect.get(globalThis, "answer")), "Ada")
  const cancelled = await pending('globalThis.answer = prompt("Cancel?"); "cancelled"')
  await session.execute({ operation: "dialog", action: "dismiss", tabID, dialogID: cancelled.id })
  await finished(cancelled.operationID!)
  assert.equal(await page.evaluate(() => Reflect.get(globalThis, "answer")), null)
  const defaulted = await pending('globalThis.answer = prompt("Default?", "Keep"); "defaulted"')
  await session.execute({ operation: "dialog", action: "accept", tabID, dialogID: defaulted.id })
  await finished(defaulted.operationID!)
  assert.equal(await page.evaluate(() => Reflect.get(globalThis, "answer")), "")
  const accepted = await pending('globalThis.effects += confirm("Accept once") ? 1 : 0; "accepted"')
  await session.execute({ operation: "dialog", action: "accept", tabID, dialogID: accepted.id })
  await finished(accepted.operationID!)
  assert.equal(await page.evaluate(() => Reflect.get(globalThis, "effects")), 1)
  await page.evaluate(() => Reflect.set(globalThis, "effects", 0))
  const first = await pending('alert("First"); alert("Second"); globalThis.effects++; "twice observed, once executed"')
  await session.execute({ operation: "dialog", action: "accept", tabID, dialogID: first.id })
  const second = await until(async () => (await list()).dialogs.find((dialog) => dialog.status === "open"))
  assert.notEqual(first.id, second.id)
  assert.equal(second.operationID, first.operationID)
  assert.equal((await list(first.operationID)).operations[0].status, "pending")
  await session.execute({ operation: "dialog", action: "dismiss", tabID, dialogID: second.id })
  await finished(first.operationID!)
  assert.equal(await page.evaluate(() => Reflect.get(globalThis, "effects")), 1)
  const race = await pending('globalThis.effects += confirm("Manual choice") ? 10 : 0; "resolved"')
  const answers = await Promise.allSettled([
    session.respond(tabID, race.id, "dismiss"),
    session.execute({ operation: "dialog", action: "accept", tabID, dialogID: race.id }),
  ])
  assert.equal(answers.filter((result) => result.status === "fulfilled").length, 1)
  await finished(race.operationID!)
  assert.equal(await page.evaluate(() => Reflect.get(globalThis, "effects")), 1)
  session.resume()
  page.once("dialog", (dialog) => {
    const accept = dialog.accept.bind(dialog)
    dialog.accept = async (text) => {
      await accept(text)
      throw new Error("Injected acknowledgement loss after native acceptance")
    }
  })
  const lost = await pending('alert("Response loss"); globalThis.effects++; "settled"')
  await assert.rejects(
    session.execute({ operation: "dialog", action: "accept", tabID, dialogID: lost.id }),
    /outcome is uncertain/,
  )
  await finished(lost.operationID!)
  assert.equal((await list()).dialogs.find((item) => item.id === lost.id)?.status, "closed")
  await session.execute({ operation: "evaluate", tabID, expression: "1" })
  assert.equal(await page.evaluate(() => Reflect.get(globalThis, "effects")), 2)
  const long = await pending('alert("x".repeat(12000)); "bounded"')
  assert.equal(long.message.length, 10000)
  assert.equal(long.truncated, true)
  await session.execute({ operation: "dialog", action: "accept", tabID, dialogID: long.id })
  await finished(long.operationID!)
  await page.evaluate(() => {
    const frame = document.createElement("iframe")
    frame.srcdoc = "<p>Frame</p>"
    document.body.append(frame)
  })
  const framed = await pending('window.frames[0].alert("Frame dialog"); "framed"')
  assert.equal(framed.tabID, tabID)
  assert.equal("frameID" in framed, false)
  await session.execute({ operation: "dialog", action: "accept", tabID, dialogID: framed.id })
  await finished(framed.operationID!)
  const popup = await context.newPage()
  const popupID = (await session.inventory()).find((tab) => tab.id !== tabID)!.id
  await assert.rejects(
    session.execute({ operation: "evaluate", tabID: popupID, expression: 'alert("Popup"); "done"' }),
    /remains pending/,
  )
  const popupState = await session.execute({ operation: "dialog", action: "list", tabID: popupID })
  assert.ok("dialogs" in popupState)
  const popupDialog = popupState.dialogs.find((dialog) => dialog.status === "open")!
  assert.equal(popupDialog.tabID, popupID)
  await session.execute({ operation: "dialog", action: "accept", tabID: popupID, dialogID: popupDialog.id })
  await until(async () => {
    const state = await session.execute({
      operation: "dialog",
      action: "list",
      tabID: popupID,
      operationID: popupDialog.operationID,
    })
    assert.ok("operations" in state)
    return state.operations[0].status === "pending" ? undefined : state.operations[0]
  })
  await popup.close()
  await page.getByRole("button").click()
  await page.evaluate(() =>
    window.addEventListener("beforeunload", (event) => {
      event.preventDefault()
      event.returnValue = ""
    }),
  )
  await assert.rejects(session.execute({ operation: "tabs", action: "close", tabID }), /remains pending/)
  const staying = (await list()).dialogs.find((dialog) => dialog.status === "open")!
  assert.equal(staying.type, "beforeunload")
  await session.execute({ operation: "dialog", action: "dismiss", tabID, dialogID: staying.id })
  const stayed = await finished(staying.operationID!)
  assert.equal(stayed.status, "failed")
  assert.match(stayed.error!, /tab remains open/)
  assert.equal(page.isClosed(), false)
  await assert.rejects(session.execute({ operation: "tabs", action: "close", tabID }), /remains pending/)
  const leaving = (await list()).dialogs.find((dialog) => dialog.status === "open")!
  await session.execute({ operation: "dialog", action: "accept", tabID, dialogID: leaving.id })
  assert.equal((await finished(leaving.operationID!)).status, "completed")
  assert.equal(page.isClosed(), true)
  assert.equal((await session.inventory()).length, 0)
} finally {
  await session.dispose()
  await context.close()
  await rm(dir, { recursive: true, force: true })
}
