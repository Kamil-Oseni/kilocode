import { test } from "bun:test"
import { build } from "esbuild"
import { chromium, expect } from "@playwright/test"
import { resolve } from "node:path"

test("actual muted AudioContext buffers measured late PCM and retires queued audio on Stop", async () => {
  const bundle = await build({
    stdin: {
      contents: `import { StreamPlayer } from ${JSON.stringify(resolve(import.meta.dir, "../../webview-ui/src/context/stream-player.ts"))};
        window.rows=[]; window.errors=[]; window.completed=0;
        window.player=new StreamPlayer(()=>window.completed++,err=>window.errors.push(err),row=>window.rows.push(row));
        window.pcm=(count,rate=24000)=>{const bytes=new Uint8Array(count*2);const view=new DataView(bytes.buffer);for(let i=0;i<count;i++)view.setInt16(i*2,i%2?-8192:8192,true);let raw='';for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192));window.player.push(btoa(raw),'audio/pcm;rate='+rate,'2373db48-53d6-4557-8651-f9a5beeded90')};`,
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
  try {
    await page.setContent("<button>Prepare</button>")
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
      window.sink = window.player.context
    })

    // Real host arrivals 1465/3337 ms: 1.24 s first PCM would end 632 ms
    // before the second chunk without a reserve. Only the arrival offset is replayed.
    await page.evaluate(async () => {
      window.rows = []
      window.pcm(29760)
      await new Promise((resolve) => setTimeout(resolve, 1872))
      window.pcm(54720)
    })
    const first = await page.evaluate(() => window.rows.filter((row) => row.event === "scheduled"))
    expect(first.length).toBe(2)
    expect(first[0].elapsed).toBeGreaterThanOrEqual(1800)
    expect(first[0].duration).toBe(1240)
    expect(Math.abs(first[1].start - first[0].start - first[0].duration)).toBeLessThanOrEqual(1)
    expect(first.every((row) => row.output === "direct" && row.state === "running")).toBe(true)

    // Real host arrivals 1668/4567 ms: the 720 ms first chunk would
    // starve for 2179 ms. The bounded 2500 ms reserve covers this pair.
    await page.evaluate(async () => {
      window.player.reset()
      window.rows = []
      window.pcm(17280)
      await new Promise((resolve) => setTimeout(resolve, 2899))
      window.pcm(94080)
    })
    const second = await page.evaluate(() => window.rows.filter((row) => row.event === "scheduled"))
    expect(await page.evaluate(() => window.player.context === window.sink && window.sink.state === "running")).toBe(
      true,
    )
    expect(second.length).toBe(2)
    expect(second[0].elapsed).toBeGreaterThanOrEqual(2400)
    expect(second[0].elapsed).toBeLessThan(2800)
    expect(second[0].duration).toBe(720)
    expect(Math.abs(second[1].start - second[0].start - second[0].duration)).toBeLessThanOrEqual(1)

    await page.evaluate(async () => {
      window.player.reset()
      window.rows = []
      window.pcm(2400)
      window.player.stop(false)
      await new Promise((resolve) => setTimeout(resolve, 2650))
    })
    expect(await page.evaluate(() => window.rows.filter((row) => row.event === "scheduled").length)).toBe(0)
    expect(await page.evaluate(() => window.completed)).toBe(0)
    await expect.poll(() => page.evaluate(() => window.sink.state)).toBe("closed")

    // Done flushes a short reply immediately, then completes once after native end.
    await page.evaluate(() => {
      window.player.unlock()
      window.sink = window.player.context
      window.rows = []
      window.pcm(2400)
      window.player.finish()
    })
    expect(await page.evaluate(() => window.rows.filter((row) => row.event === "scheduled").length)).toBe(1)
    await expect.poll(() => page.evaluate(() => window.completed)).toBe(1)
    expect(await page.evaluate(() => window.player.context === window.sink && window.sink.state === "running")).toBe(
      true,
    )
    await page.waitForTimeout(100)
    expect(await page.evaluate(() => window.completed)).toBe(1)

    // A first chunk already containing two seconds starts without the timer.
    await page.evaluate(() => {
      window.rows = []
      window.pcm(48000)
    })
    const immediate = await page.evaluate(() => window.rows.find((row) => row.event === "scheduled"))
    expect(immediate.duration).toBe(2000)
    expect(await page.evaluate(() => window.player.context === window.sink)).toBe(true)
    expect(immediate.elapsed).toBeLessThan(100)
    // An exhausted stream reports underrun and reserves its next short chunk;
    // final Done releases that reserve rather than waiting indefinitely.
    await expect.poll(() => page.evaluate(() => window.rows.some((row) => row.event === "underrun"))).toBe(true)
    await page.evaluate(() => window.pcm(2400))
    expect(await page.evaluate(() => window.rows.filter((row) => row.event === "scheduled").length)).toBe(1)
    await page.evaluate(() => window.player.finish())
    expect(await page.evaluate(() => window.rows.filter((row) => row.event === "scheduled").length)).toBe(2)
    await expect.poll(() => page.evaluate(() => window.completed)).toBe(2)
    await page.evaluate(() => window.player.reset())

    // Actual decoder queue rejects excess pending chunks and duration before scheduling.
    await page.evaluate(() => {
      window.rows = []
      for (let index = 0; index < 65; index++) window.pcm(1)
    })
    expect(await page.evaluate(() => window.errors)).toEqual(["Voice playback buffer exceeds its bound."])
    expect(await page.evaluate(() => window.rows.some((row) => row.event === "scheduled"))).toBe(false)
    await page.evaluate(() => window.pcm(543000, 3000))
    expect(await page.evaluate(() => window.errors.length)).toBe(2)
    await page.evaluate(() => window.player.stop(false))
  } finally {
    await browser.close()
  }
}, 30000)
