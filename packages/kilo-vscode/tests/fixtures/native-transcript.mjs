import assert from "node:assert/strict"
import { chromium } from "@playwright/test"

const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 360, height: 1050 } })
    await page.goto(`http://127.0.0.1:5201/?native&theme=${theme}`)
    await page.evaluate(() => window.__configureVoice())
    await page.getByRole("button", { name: "Start voice", exact: true }).click()
    const request = await page.evaluate(() =>
      window.__composerMessages.find((message) => message.type === "speechOpenAIStart"),
    )
    await page.evaluate(
      (requestId) => window.postMessage({ type: "speechOpenAIReady", requestId, sdp: "local-answer" }, "*"),
      request.requestId,
    )
    await page.getByRole("button", { name: "Mute microphone", exact: true }).waitFor()
    await page.getByRole("button", { name: "Toggle busy", exact: true }).click()
    const usage = {
      responses: 2,
      transcriptions: 1,
      seconds: 2.75,
      durations: 1,
      input: 100,
      output: 25,
      missing: 0,
      invalid: 0,
      recorded: 3,
      unrecorded: 0,
      pending: 0,
      incomplete: false,
    }
    const meter = page.locator('[data-slot="native-voice-usage"]')
    await page.evaluate(
      (usage) => window.postMessage({ type: "speechOpenAIUsage", requestId: "stale", sessionID: "first", usage }, "*"),
      usage,
    )
    assert.equal(await meter.count(), 0)
    await page.evaluate(
      ({ requestId, usage }) =>
        window.postMessage({ type: "speechOpenAIUsage", requestId, sessionID: "first", usage }, "*"),
      { requestId: request.requestId, usage },
    )
    await meter
      .getByText("Voice usage: 100 input / 25 output tokens reported; 2.8s transcription", { exact: true })
      .waitFor()
    await meter.locator("summary").click()
    await meter.getByText("No voice spending cap is enforced by this meter.", { exact: true }).waitFor()
    await page.evaluate(
      ({ requestId, usage }) =>
        window.postMessage(
          { type: "speechOpenAIUsage", requestId, sessionID: "other", usage: { ...usage, input: 999 } },
          "*",
        ),
      { requestId: request.requestId, usage },
    )
    assert.equal(
      await meter
        .getByText("Voice usage: 100 input / 25 output tokens reported; 2.8s transcription", { exact: true })
        .count(),
      1,
    )
    const view = page.locator('[data-slot="voice-transcript"]')
    const send = (packet) => page.evaluate((packet) => window.__nativeEvent(packet), packet)
    const delta = {
      type: "response.output_audio_transcript.delta",
      response_id: "first_response",
      item_id: "first_item",
      content_index: 0,
      delta: "Generated ahead of playback",
    }
    await send(delta)
    await view.getByText("Generated transcript (partial)", { exact: true }).waitFor()
    assert.equal(await view.getAttribute("data-partial"), "true")
    await send({ ...delta, type: "response.output_audio_transcript.done", transcript: "Generated ahead of playback" })
    await view.getByText("Generated transcript (final text; playback unverified)", { exact: true }).waitFor()
    await send({ type: "output_audio_buffer.started", response_id: "first_response" })
    await page.getByRole("button", { name: "Stop speaking", exact: true }).click()
    await view
      .getByText("Speech interrupted. Heard words are unavailable; waiting for provider confirmation.", { exact: true })
      .waitFor()
    assert.equal(await view.getByText("Generated ahead of playback", { exact: true }).count(), 0)
    await send({ type: "conversation.item.truncated", item_id: "first_item", content_index: 0, audio_end_ms: 1250 })
    await view
      .getByText("Speech interrupted. Provider confirmed an audio cutoff at 1250 ms; heard words are unavailable.", {
        exact: true,
      })
      .waitFor()
    assert.equal(await page.evaluate(() => window.__workStops), 0)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.screenshot({ path: `../../.tmp/native-transcript-${theme}.png`, fullPage: true })
    await send({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "user",
      transcript: "Newer user input",
    })
    await view.getByText("Newer user input", { exact: true }).waitFor()
    await send({ type: "conversation.item.truncated", item_id: "first_item", content_index: 0, audio_end_ms: 1000 })
    await send({ ...delta, type: "response.output_audio_transcript.done", transcript: "Late unheard text" })
    assert.equal(await view.getByText("Newer user input", { exact: true }).count(), 1)
    assert.equal(await view.getByText("Late unheard text", { exact: true }).count(), 0)
    await send({ ...delta, response_id: "vad_response", item_id: "vad_item", delta: "Automatic interruption text" })
    await send({ type: "output_audio_buffer.started", response_id: "vad_response" })
    await send({ type: "input_audio_buffer.speech_started" })
    await view
      .getByText("Speech interrupted. Heard words are unavailable; waiting for provider confirmation.", { exact: true })
      .waitFor()
    assert.equal(await view.getByText("Automatic interruption text", { exact: true }).count(), 0)
    await send({ type: "conversation.item.truncated", item_id: "vad_item", content_index: 0, audio_end_ms: 0 })
    await view
      .getByText("Speech interrupted. Provider confirmed an audio cutoff at 0 ms; heard words are unavailable.", {
        exact: true,
      })
      .waitFor()
    await page.evaluate(() => {
      for (let count = 0; count < 257; count++)
        window.__nativeEvent({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: `limit_${count}`,
          transcript: "bounded",
        })
      window.__nativeEvent({
        type: "response.output_audio_transcript.delta",
        response_id: "first_response",
        item_id: "first_item",
        delta: "resurrected",
      })
      window.__staleVoiceEvent = window.__nativeEvent
    })
    await view
      .getByText("Transcript display limit reached. Voice continues; start a new voice call to reset the display.", {
        exact: true,
      })
      .waitFor()
    assert.equal(await view.getByText("resurrected", { exact: true }).count(), 0)
    assert.equal(await page.evaluate(() => window.__workStops), 0)
    await page.getByRole("button", { name: "End voice", exact: true }).click()
    assert.equal(
      await meter
        .getByText("Voice usage: 100 input / 25 output tokens reported; 2.8s transcription", { exact: true })
        .count(),
      1,
    )
    await page.evaluate(
      (requestId) => window.postMessage({ type: "speechOpenAIStopped", requestId }, "*"),
      request.requestId,
    )
    await page.getByRole("button", { name: "Restart voice in this task", exact: true }).click()
    assert.equal(await meter.count(), 0)
    const next = await page.evaluate(() =>
      window.__composerMessages.filter((message) => message.type === "speechOpenAIStart").at(-1),
    )
    await page.evaluate(
      (requestId) => window.postMessage({ type: "speechOpenAIReady", requestId, sdp: "local-answer" }, "*"),
      next.requestId,
    )
    await send({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "fresh",
      transcript: "Fresh call transcript",
    })
    await page.evaluate(() =>
      window.__staleVoiceEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "stale",
        transcript: "Stale call transcript",
      }),
    )
    await view.getByText("Fresh call transcript", { exact: true }).waitFor()
    assert.equal(await view.getByText("Stale call transcript", { exact: true }).count(), 0)
    assert.equal(await page.evaluate(() => window.__workStops), 0)
    await page.evaluate(
      ({ requestId, usage }) =>
        window.postMessage(
          {
            type: "speechOpenAIUsage",
            requestId,
            sessionID: "first",
            usage: { ...usage, input: 10, incomplete: true, unrecorded: 1 },
          },
          "*",
        ),
      { requestId: next.requestId, usage },
    )
    await meter.locator("summary").click()
    await meter.getByRole("status").filter({ hasText: "retained usage record is incomplete" }).waitFor()
    for (const [status, caption] of [
      ["failed", "Voice response failed. Generated text is hidden because heard words are unavailable."],
      ["incomplete", "Voice response ended unfinished. Generated text is hidden because heard words are unavailable."],
      ["cancelled", "Voice response was cancelled. Generated text is hidden because heard words are unavailable."],
    ]) {
      await send({ ...delta, response_id: status, item_id: status, delta: "Unheard terminal output" })
      await send({ type: "response.done", response: { id: status, status } })
      await view.getByText(caption, { exact: true }).waitFor()
      assert.equal(await view.getByText("Unheard terminal output", { exact: true }).count(), 0)
    }
    await page.getByRole("button", { name: "Switch session", exact: true }).click()
    assert.equal(await view.getByText("Fresh call transcript", { exact: true }).count(), 0)
    assert.equal(await meter.count(), 0)
    console.log(
      `${theme}: actual composer interruption, confirmed cutoff, VAD, late-event selection, display capacity and old-call fences and session-owned token/duration usage summary passed; work preserved`,
    )
    await page.close()
  }
} finally {
  await browser.close()
}
