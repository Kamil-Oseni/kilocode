import assert from "node:assert/strict"
import { chromium } from "@playwright/test"

const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 360, height: 1050 } })
    await page.goto(`http://127.0.0.1:5201/?native&theme=${theme}`)
    await page.evaluate(() => window.__configureVoice())
    const post = (message) => page.evaluate((message) => window.postMessage(message, "*"), message)
    const latest = () =>
      page.evaluate(() => window.__composerMessages.filter((entry) => entry.type === "speechOpenAIStart").at(-1))
    await page.getByRole("button", { name: "Start voice", exact: true }).click()
    const first = await latest()
    await post({ type: "speechOpenAIReady", requestId: first.requestId, sdp: "local-answer" })
    await page.getByRole("button", { name: "Mute microphone", exact: true }).waitFor()
    await page.getByRole("button", { name: "Toggle busy", exact: true }).click()
    await page.evaluate(() => {
      window.__voiceHoldCleanup = true
    })
    await page.getByRole("button", { name: "End voice", exact: true }).click()
    const panel = page.getByRole("group", { name: "Restart voice", exact: true })
    const restart = panel.getByRole("button", { name: "Restart voice in this task", exact: true })
    await panel.getByText(/A new voice call shares recent saved context/).waitFor()
    assert.equal(await restart.isDisabled(), true)
    await post({ type: "speechOpenAIStopped", requestId: "unrelated" })
    assert.equal(await restart.isDisabled(), true)
    await post({ type: "speechOpenAIStopped", requestId: first.requestId })
    assert.equal(await restart.isDisabled(), true)
    assert.equal(await page.evaluate(() => window.__voiceStarts), 1)
    await page.evaluate(() => {
      window.__voiceHoldCleanup = false
      window.__releaseVoiceCleanup()
    })
    await page.waitForFunction(() => !document.querySelector('[data-slot="native-voice-recovery"] button').disabled)
    assert.equal(await page.evaluate(() => window.__voiceStarts), 1)
    assert.equal(await page.getByRole("button", { name: "Start voice", exact: true }).count(), 0)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.screenshot({ path: `../../.tmp/native-recovery-ready-${theme}.png`, fullPage: true })
    await restart.click()
    const second = await latest()
    assert.notEqual(second.requestId, first.requestId)
    assert.equal(second.sessionID, first.sessionID)
    assert.equal(await page.evaluate(() => window.__voiceStarts), 2)
    await post({ type: "speechOpenAIReady", requestId: first.requestId, sdp: "stale-answer" })
    await post({ type: "speechOpenAIReady", requestId: second.requestId, sdp: "local-answer" })
    await post({ type: "speechOpenAIError", requestId: second.requestId, error: "Connection was lost" })
    await panel.waitFor()
    assert.equal(await restart.isDisabled(), true)
    await post({ type: "speechOpenAIError", requestId: second.requestId, error: "Host cleanup remains unconfirmed" })
    await panel.getByRole("status").filter({ hasText: "cleanup is unconfirmed" }).waitFor()
    await post({ type: "speechOpenAIStopped", requestId: first.requestId })
    assert.equal(await restart.isDisabled(), true)
    await post({ type: "speechOpenAIStopped", requestId: second.requestId })
    await restart.click()
    const third = await latest()
    await post({ type: "speechOpenAIReady", requestId: third.requestId, sdp: "local-answer" })
    await page.evaluate(() => {
      window.__voiceHoldCleanup = true
    })
    await page.getByRole("button", { name: "End voice", exact: true }).click()
    await post({ type: "speechOpenAIStopped", requestId: third.requestId })
    await page.evaluate(() => window.__failVoiceCleanup(new Error("Local cleanup failed")))
    await panel.getByRole("status").filter({ hasText: "cleanup is unconfirmed" }).waitFor()
    assert.equal(await restart.isDisabled(), true)
    assert.equal(await page.evaluate(() => window.__voiceStarts), 3)
    assert.equal(await page.evaluate(() => window.__workStops), 0)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.screenshot({ path: `../../.tmp/native-recovery-blocked-${theme}.png`, fullPage: true })
    await page.getByRole("button", { name: "Switch session", exact: true }).click()
    assert.equal(await panel.count(), 0)
    await page.getByRole("button", { name: "Switch session", exact: true }).click()
    assert.equal(await panel.count(), 0)
    assert.equal(await page.evaluate(() => window.__voiceStarts), 3)
    assert.equal(await page.evaluate(() => window.__workStops), 0)
    assert.equal(
      await page.evaluate(() => window.__composerMessages.some((entry) => entry.type === "sendMessage")),
      false,
    )
    console.log(
      `${theme}: explicit fresh-call recovery, exact host/local cleanup gates, failure blocking, task invalidation and preserved work passed`,
    )
    await page.close()
  }
} finally {
  await browser.close()
}
