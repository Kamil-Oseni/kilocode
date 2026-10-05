import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { isServer } from "solid-js/web"
import { createVoiceSession } from "../../webview-ui/src/utils/voice-session"

test("fresh Voice admission creates once and starts only after actual reactive session binding", async () => {
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
    ).toContain("1 pass")
    return
  }
  const started: string[] = []
  const requests: { signal: AbortSignal; resolve: (id?: string) => void }[] = []
  const root = createRoot((dispose) => {
    const [id, setID] = createSignal<string>()
    const [connected, setConnected] = createSignal(true)
    const session = createVoiceSession({
      id,
      connected,
      create: (signal) => new Promise((resolve) => requests.push({ signal, resolve })),
      start: (value) => started.push(value),
    })
    return { dispose, session, setID, setConnected }
  })
  try {
    root.session.start()
    root.session.start()
    expect(requests).toHaveLength(1)
    expect(root.session.pending()).toBe(true)
    root.setID("unrelated")
    await Promise.resolve()
    expect(started).toEqual([])
    root.setID("fresh")
    requests[0].resolve("fresh")
    await Promise.resolve()
    expect(started).toEqual(["fresh"])
    expect(root.session.pending()).toBe(false)
    root.setID(undefined)
    root.session.start()
    root.session.cancel()
    expect(root.session.pending()).toBe(false)
    expect(requests[1].signal.aborted).toBe(true)
    root.setID("late-cancelled")
    requests[1].resolve("late-cancelled")
    await Promise.resolve()
    expect(started).toEqual(["fresh"])
    root.setID(undefined)
    root.session.start()
    root.setConnected(false)
    expect(root.session.pending()).toBe(false)
    expect(requests[2].signal.aborted).toBe(true)
    root.setID("late-disconnected")
    requests[2].resolve("late-disconnected")
    await Promise.resolve()
    expect(started).toEqual(["fresh"])
    root.setConnected(true)
    root.setID(undefined)
    root.session.start()
    root.dispose()
    expect(root.session.pending()).toBe(false)
    expect(requests[3].signal.aborted).toBe(true)
    root.setID("late-unmounted")
    requests[3].resolve("late-unmounted")
    await Promise.resolve()
    expect(started).toEqual(["fresh"])
  } finally {
    root.dispose()
  }
})
