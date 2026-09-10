import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { chromium } from "@playwright/test"

await mkdir("../../.tmp", { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 360, height: 1050 } })
    await page.goto(`http://127.0.0.1:5201/?native&theme=${theme}`)
    await page.evaluate(() => window.__configureVoice())
    assert.equal(
      await page.evaluate(
        () => window.__composerMessages.filter((message) => message.type === "speechOpenAIStart").length,
      ),
      0,
    )
    await page.getByRole("button", { name: "Start voice", exact: true }).click()
    const controls = page.getByRole("group", { name: "Voice controls" })
    await controls.waitFor()
    assert.equal(await controls.getByRole("button", { name: "Mute microphone", exact: true }).isDisabled(), true)
    const request = await page.evaluate(() =>
      window.__composerMessages.find((message) => message.type === "speechOpenAIStart"),
    )
    await page.evaluate(
      (requestId) => window.postMessage({ type: "speechOpenAIReady", requestId, sdp: "local-answer" }, "*"),
      request.requestId,
    )
    await controls.getByRole("button", { name: "Mute microphone", exact: true }).click()
    assert.equal(await page.evaluate(() => window.__voiceMicrophone), true)
    assert.equal(
      await controls.getByRole("button", { name: "Unmute microphone", exact: true }).getAttribute("aria-pressed"),
      "true",
    )
    await controls.getByRole("button", { name: "Unmute microphone", exact: true }).click()
    assert.equal(await page.evaluate(() => window.__voiceMicrophone), false)
    await page.getByRole("button", { name: "Toggle busy", exact: true }).click()
    await page.evaluate(() => window.__nativeTransport.sink.status("speaking"))
    await controls.getByRole("button", { name: "Stop speaking", exact: true }).click()
    const interruption = await page.evaluate(() =>
      window.__composerMessages.find((message) => message.type === "speechOpenAIInterrupt"),
    )
    assert.equal(interruption.requestId, request.requestId)
    assert.equal(interruption.responseID, "utterance")
    assert.equal(await page.evaluate(() => window.__workStops), 0)
    await page.evaluate(() => window.__nativeTransport.sink.status("speaking"))
    assert.equal(await controls.getByRole("button", { name: "Stop speaking", exact: true }).isEnabled(), true)
    await controls.getByRole("button", { name: "Mute microphone", exact: true }).click()

    const picker = controls.locator('[data-slot="native-voice-image"] input')
    await picker.setInputFiles({ name: "large.png", mimeType: "image/png", buffer: Buffer.alloc(8 * 1024 * 1024 + 1) })
    await controls.getByRole("alert").filter({ hasText: "no larger than 8 MiB" }).waitFor()
    await picker.setInputFiles({ name: "wrong.png", mimeType: "image/png", buffer: Buffer.from("<svg></svg>") })
    await controls.getByRole("alert").filter({ hasText: "not a supported raster" }).waitFor()
    const source = await page.evaluate(() => {
      const canvas = document.createElement("canvas")
      canvas.width = 2400
      canvas.height = 1200
      const context = canvas.getContext("2d")
      context.fillStyle = "#369"
      context.fillRect(0, 0, 2400, 1200)
      return canvas.toDataURL("image/png")
    })
    const file = { name: "voice image.png", mimeType: "image/png", buffer: Buffer.from(source.split(",")[1], "base64") }
    await picker.setInputFiles(file)
    await controls.getByRole("img", { name: "Selected image: voice image.png" }).waitFor()
    assert.equal(
      await page.evaluate(
        () => window.__composerMessages.filter((message) => message.type === "speechOpenAIImage").length,
      ),
      0,
    )
    const dimensions = await controls.getByRole("img").evaluate((image) => [image.naturalWidth, image.naturalHeight])
    assert.deepEqual(dimensions, [1600, 800])
    await controls.getByRole("button", { name: "Share image with voice", exact: true }).click()
    const first = await page.evaluate(() =>
      window.__composerMessages.find((message) => message.type === "speechOpenAIImage"),
    )
    assert.equal(first.requestId, request.requestId)
    assert.match(first.data, /^data:image\/jpeg;base64,/)
    assert.ok(Buffer.from(first.data.split(",")[1], "base64").length <= 256 * 1024)
    await page.evaluate(
      (message) =>
        window.postMessage(
          { type: "speechOpenAIImageResult", requestId: "stale", imageID: message.imageID, status: "shared" },
          "*",
        ),
      first,
    )
    await controls.getByRole("status").filter({ hasText: "Sharing image" }).waitFor()
    await page.evaluate(
      (message) =>
        window.postMessage(
          {
            type: "speechOpenAIImageResult",
            requestId: message.requestId,
            imageID: message.imageID,
            status: "failed",
            error: "Provider rejected this image",
          },
          "*",
        ),
      first,
    )
    await controls.getByRole("status").filter({ hasText: "Image sharing failed" }).waitFor()
    assert.equal(await controls.getByRole("button", { name: "Share image with voice", exact: true }).isDisabled(), true)
    await picker.setInputFiles(file)
    await controls.getByRole("button", { name: "Share image with voice", exact: true }).click()
    const second = await page.evaluate(() =>
      window.__composerMessages.filter((message) => message.type === "speechOpenAIImage").at(-1),
    )
    assert.notEqual(second.imageID, first.imageID)
    await page.evaluate(
      (message) =>
        window.postMessage(
          { type: "speechOpenAIImageResult", requestId: message.requestId, imageID: message.imageID, status: "shared" },
          "*",
        ),
      second,
    )
    await controls.getByRole("status").filter({ hasText: "Image shared. Sharing does not start work." }).waitFor()
    assert.equal(await page.evaluate(() => window.__workStops), 0)
    assert.equal(
      await page.evaluate(() => window.__composerMessages.some((message) => message.type === "sendMessage")),
      false,
    )
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.screenshot({ path: `../../.tmp/native-voice-controls-${theme}.png`, fullPage: true })

    await page.evaluate(() => {
      const original = window.createImageBitmap
      window.createImageBitmap = async (...args) => {
        const bitmap = await original(...args)
        const close = bitmap.close.bind(bitmap)
        bitmap.close = () => {
          window.__voiceBitmapClosed = true
          close()
        }
        return new Promise((resolve) => {
          window.__releaseVoiceImage = () => resolve(bitmap)
        })
      }
    })
    await picker.setInputFiles(file)
    await page.waitForFunction(() => !!window.__releaseVoiceImage)
    await controls.getByRole("button", { name: "End voice", exact: true }).click()
    await page.evaluate(() => window.__releaseVoiceImage())
    await page.waitForFunction(() => window.__voiceBitmapClosed === true)
    assert.equal(await controls.count(), 0)
    assert.equal(
      await page.evaluate(
        () => window.__composerMessages.filter((message) => message.type === "speechOpenAIImage").length,
      ),
      2,
    )
    assert.equal(await page.evaluate(() => window.__workStops), 0)
    assert.ok(await page.evaluate(() => window.__voiceStopped > 0))
    await page.getByRole("button", { name: "Stop work", exact: true }).click()
    assert.equal(await page.evaluate(() => window.__workStops), 1)
    console.log(
      `${theme}: actual composer controls preserve work; deliberate bounded image, failed-image no replay, stale ack/decode fence, visible retention and no overflow passed`,
    )
    await page.close()
  }
} finally {
  await browser.close()
}
