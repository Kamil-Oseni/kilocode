import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { VoiceLoop } from "../../webview-ui/src/context/voice-loop"

test("explicit stop fences late phases and completions until explicit listen", () => {
  const events: string[] = []
  const loop = new VoiceLoop({ listen: () => events.push("listen"), stop: () => events.push("stop") })
  loop.set("hands-free")
  loop.listen()
  loop.stop()
  loop.done()
  loop.wait()
  loop.speak()
  loop.hear()
  expect(loop.paused()).toBe(true)
  expect(loop.state().phase).toBe("idle")
  expect(events).toEqual(["listen", "stop"])
  loop.listen()
  expect(loop.paused()).toBe(false)
  expect(loop.state().phase).toBe("listening")
})

test("actual browser local hands-free control remains available and fences late callbacks", async () => {
  const child = Bun.spawn([process.execPath, "--conditions=browser", "tests/fixtures/voice-hands-free-stop.mjs"], {
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
  expect(out).toContain("13 actual hands-free stop assertions passed")
}, 30_000)
