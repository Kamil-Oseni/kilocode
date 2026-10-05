import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { isServer } from "solid-js/web"
import { bootstrap } from "../../webview-ui/src/context/model-bootstrap"

test("model preferences wait for connection and reload once per reconnect", async () => {
  if (isServer) {
    const child = Bun.spawn([process.execPath, "--conditions=browser", "test", import.meta.path], {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    const joined = await Promise.allSettled([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    for (const row of joined) expect(row.status).toBe("fulfilled")
    expect((joined[0] as PromiseFulfilledResult<number>).value).toBe(0)
    expect(
      (joined[1] as PromiseFulfilledResult<string>).value + (joined[2] as PromiseFulfilledResult<string>).value,
    ).toContain("8 expect() calls")
    return
  }
  const requests: string[] = []
  const root = createRoot((dispose) => {
    const [connected, connect] = createSignal(false)
    const [picker, select] = createSignal("Voice")
    bootstrap(connected, () => requests.push(picker()))
    return { dispose, connect, select }
  })
  try {
    expect(requests).toEqual([])
    root.select("Code")
    expect(requests).toEqual([])
    root.connect(true)
    expect(requests).toEqual(["Code"])
    root.connect(true)
    expect(requests).toEqual(["Code"])
    root.select("Voice")
    expect(requests).toEqual(["Code"])
    root.connect(false)
    expect(requests).toEqual(["Code"])
    root.connect(true)
    expect(requests).toEqual(["Code", "Voice"])
    root.dispose()
    root.connect(false)
    root.connect(true)
    expect(requests).toEqual(["Code", "Voice"])
  } finally {
    root.dispose()
  }
})
