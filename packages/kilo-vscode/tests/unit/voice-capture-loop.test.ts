import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { VoiceLoop } from "../../webview-ui/src/context/voice-loop"

test("capture failure stays paused across late playback completion until explicit retry", () => {
  const events: string[] = []
  const loop = new VoiceLoop({ listen: () => events.push("listen"), stop: () => events.push("stop") })
  loop.set("hands-free")
  loop.listen()
  loop.wait()
  loop.pause()
  expect(loop.paused()).toBe(true)
  expect(loop.state()).toEqual({ mode: "hands-free", phase: "idle" })
  loop.done()
  loop.hear()
  expect(events).toEqual(["listen", "stop"])
  expect(loop.paused()).toBe(true)
  loop.listen()
  expect(loop.paused()).toBe(false)
  expect(loop.state().phase).toBe("listening")
  loop.done()
  expect(events).toEqual(["listen", "stop", "listen"])
})

test("actual browser VoiceProvider fences late chunks and readonly settings while paused", async () => {
  const child = Bun.spawn([process.execPath, "--conditions=browser", "tests/fixtures/voice-capture-pause.mjs"], {
    cwd: resolve(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, out + err).toBe(0)
  expect(out).toContain("11 actual VoiceProvider pause assertions passed")
}, 30_000)
