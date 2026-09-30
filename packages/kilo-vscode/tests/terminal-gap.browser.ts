import { expect, test } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    class Socket {
      static OPEN = 1
      readyState = 1
      binaryType = "blob"
      onopen?: (event: Event) => void
      onmessage?: (event: MessageEvent) => void
      onclose?: (event: CloseEvent) => void
      onerror?: (event: Event) => void
      constructor(readonly url: string) {
        const state = window as unknown as { __ptySockets: Socket[] }
        ;(state.__ptySockets ??= []).push(this)
        queueMicrotask(() => this.onopen?.(new Event("open")))
      }
      send(_data: string) {}
      close() {
        this.end(1000)
      }
      emit(data: string | ArrayBuffer) {
        this.onmessage?.(new MessageEvent("message", { data }))
      }
      end(code: number) {
        this.readyState = 3
        this.onclose?.(new CloseEvent("close", { code }))
      }
    }
    Object.defineProperty(window, "WebSocket", { value: Socket, configurable: true })
  })
})

test("a replay gap stays visible after terminal clear-screen output", async ({ page }) => {
  await page.goto("/?state=terminal-gap")
  await expect(page.locator("[data-terminal-id='preview-terminal'] .xterm")).toBeVisible()
  await page.evaluate(() => {
    const socket = (window as unknown as { __ptySockets: Array<{ emit(data: string | ArrayBuffer): void }> })
      .__ptySockets[0]!
    socket.emit("\x1b[2J\x1b[HRetained output\r\n")
    socket.emit(
      new TextEncoder().encode(
        '\0{"cursor":4000000,"replayGap":{"requestedCursor":0,"retainedFrom":2000000,"retainedTo":4000000}}',
      ).buffer,
    )
    socket.emit("\x1b[2J\x1b[HNew screen\r\n")
  })
  const notice = page.locator("[data-terminal-notice]")
  await expect(notice).toHaveText("Earlier terminal output is no longer available.")
  await expect(notice).toBeVisible()
  await expect(notice).toHaveAttribute("role", "status")
})

test("closing before replay metadata leaves a durable uncertainty notice through restart", async ({ page }) => {
  await page.goto("/?state=terminal-gap")
  await expect(page.locator("[data-terminal-id='preview-terminal'] .xterm")).toBeVisible()
  await page.evaluate(() => {
    const socket = (window as unknown as { __ptySockets: Array<{ emit(data: string): void; end(code: number): void }> })
      .__ptySockets[0]!
    socket.emit("Partial replay\r\n")
    socket.end(1000)
  })
  const notice = page.locator("[data-terminal-notice]")
  await expect(notice).toHaveText("Terminal output may be incomplete.")
  await page.evaluate(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "agentManager.terminal.restarted",
          terminalId: "preview-terminal",
          wsUrl: "ws://127.0.0.1:5199/restarted-pty",
        },
      }),
    ),
  )
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __ptySockets: unknown[] }).__ptySockets.length))
    .toBe(2)
  await page.evaluate(() => {
    const socket = (window as unknown as { __ptySockets: Array<{ emit(data: ArrayBuffer): void }> }).__ptySockets[1]!
    socket.emit(new TextEncoder().encode('\0{"cursor":0}').buffer)
  })
  await expect(notice).toHaveText("Terminal output may be incomplete.")
})
