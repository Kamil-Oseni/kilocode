import { test } from "bun:test"
import { build } from "esbuild"
import { chromium, expect } from "@playwright/test"
import { resolve } from "node:path"

test("actual muted browser PCM schedules nonzero samples and bounds diagnostics", async () => {
  const bundle = await build({
    stdin: {
      contents: `import { StreamPlayer } from ${JSON.stringify(resolve(import.meta.dir, "../../webview-ui/src/context/stream-player.ts"))};
        window.rows=[]; window.errors=[];
        window.player=new StreamPlayer(()=>window.finished=true,()=>window.errors.push('failed'),row=>window.rows.push(row));
        window.rejecting=new StreamPlayer(()=>window.rejectedComplete=true,()=>window.errors.push('observer-playback-failed'),()=>{throw new Error('must-not-be-logged')});`,
      resolveDir: import.meta.dir,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
  })
  const browser = await chromium.launch({ headless: true, channel: "msedge", args: ["--mute-audio"] })
  const page = await browser.newPage()
  const warnings: string[] = []
  page.on("console", (message) => {
    if (message.type() === "warning") warnings.push(message.text())
  })
  try {
    await page.setContent('<button id="start">Prepare</button>')
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    await page.evaluate(() => {
      Object.defineProperty(window, "RTCPeerConnection", { value: undefined })
      document.querySelector("button")!.addEventListener("click", () => window.player.unlock())
    })
    await page.click("button")
    await expect
      .poll(() => page.evaluate(() => window.rows.some((row) => row.event === "resumed" && row.state === "running")))
      .toBe(true)
    await page.evaluate(() => {
      const bytes = new Uint8Array(4800)
      const view = new DataView(bytes.buffer)
      for (let index = 0; index < 2400; index++) view.setInt16(index * 2, index % 2 ? -8192 : 8192, true)
      const data = btoa(String.fromCharCode(...bytes))
      window.player.push(data, "audio/pcm;rate=24000", "d649f5e4-9ea0-4b47-ba6b-777e0433dc5c")
      window.player.finish()
    })
    await expect.poll(() => page.evaluate(() => !!window.finished)).toBe(true)
    const rows = await page.evaluate(() => window.rows)
    expect(rows).toContainEqual(
      expect.objectContaining({
        event: "pcm",
        request: "d649f5e4-9ea0-4b47-ba6b-777e0433dc5c",
        bytes: 4800,
        count: 2400,
        rate: 24000,
        peak: 0.25,
        state: "running",
      }),
    )
    expect(rows.some((row) => row.event === "scheduled" && row.output === "direct" && row.state === "running")).toBe(
      true,
    )
    expect(rows.some((row) => row.event === "ended" && row.count === 2400)).toBe(true)
    expect(
      rows.every((row) =>
        Object.keys(row).every((key) =>
          [
            "event",
            "request",
            "state",
            "bytes",
            "count",
            "rate",
            "peak",
            "output",
            "elapsed",
            "at",
            "start",
            "remaining",
            "duration",
          ].includes(key),
        ),
      ),
    ).toBe(true)
    expect(await page.evaluate(() => window.errors)).toEqual([])
    await page.evaluate(() => {
      window.rows = []
      for (let index = 0; index < 100; index++) window.player.unlock()
    })
    expect(await page.evaluate(() => window.rows.length)).toBeLessThanOrEqual(24)
    await page.evaluate(() => {
      window.player.reset()
      window.rows = []
      window.player.push("ACAAIA==", "audio/pcm;rate=24000", "secret-non-uuid")
      window.player.finish()
    })
    expect((await page.evaluate(() => window.rows)).some((row) => row.request === "secret-non-uuid")).toBe(false)
    await page.evaluate(() => {
      window.rejecting.unlock()
      window.rejecting.push("ACAAIA==", "audio/pcm;rate=24000", "secret-non-uuid")
      window.rejecting.finish()
    })
    await expect.poll(() => page.evaluate(() => !!window.rejectedComplete)).toBe(true)
    expect(await page.evaluate(() => window.errors)).toEqual([])
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings.every((value) => value === "[Raya Voice playback] Diagnostic observer failed.")).toBe(true)
    await page.evaluate(() => {
      window.player.stop(false)
      window.rejecting.stop(false)
    })
  } finally {
    await browser.close()
  }
}, 30000)
