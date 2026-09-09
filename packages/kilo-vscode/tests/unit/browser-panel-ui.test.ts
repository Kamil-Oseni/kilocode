// raya_change - smooth browser takeover panel contract
import { describe, expect, it } from "bun:test"
import { Window } from "happy-dom"

const source = await Bun.file(new URL("../../src/services/browser-automation/browser-panel.ts", import.meta.url)).text()

describe("Raya browser takeover panel", () => {
  it("shows live attempt state and an explicit resume control", () => {
    expect(source).toContain('id="status"')
    expect(source).toContain('id="resume"')
    expect(source).toContain('attempt " + state.attempts + " of 3')
    expect(source).toContain('send("resume")')
  })

  it("locks panel input while an agent action is in progress", () => {
    expect(source).toContain('id="shield"')
    expect(source).toContain("[hidden] { display: none !important; }")
    expect(source).toContain('id="takeover"')
    expect(source).toContain('send("takeover")')
    expect(source).toContain("control.disabled = state.busy && !manual")
    expect(source).toContain("shield.hidden = manual || !state.busy")
  })

  it("supports Enter and an explicit Go button for manual navigation", () => {
    expect(source).toContain('id="go"')
    expect(source).toContain('go.addEventListener("click", visit)')
    expect(source).toContain("event.preventDefault();")
    expect(source).toContain("url.blur();")
  })
})

it("binds panel input to displayed tab identity and hides stale frames", () => {
  const window = new Window({ url: "https://panel.test" })
  const sent: Record<string, unknown>[] = []
  try {
    window.document.body.innerHTML = source.split("<body>")[1].split("<script nonce=")[0]
    Reflect.set(window, "acquireVsCodeApi", () => ({
      postMessage: (message: Record<string, unknown>) => sent.push(message),
    }))
    const script = source.match(/<script nonce="[^"\n]+">([\s\S]*?)<\/script>/)?.[1]
    expect(script).toBeDefined()
    new Function("window", "document", "acquireVsCodeApi", "requestAnimationFrame", script!)(
      window,
      window.document,
      Reflect.get(window, "acquireVsCodeApi"),
      window.requestAnimationFrame.bind(window),
    )
    const message = (data: unknown) => window.dispatchEvent(new window.MessageEvent("message", { data }))
    const inventory = (selected: string) =>
      message({
        type: "tabs",
        tabs: [
          { id: "first", title: "First", selected: selected === "first" },
          { id: "second", title: "Second", selected: selected === "second", openerID: "first" },
        ],
      })
    inventory("first")
    message({ type: "frame", tabID: "first", data: "", width: 100, height: 100, url: "https://first.test" })
    window.document.getElementById("reload")!.click()
    expect(sent.at(-1)).toMatchObject({ type: "reload", tabID: "first" })
    inventory("second")
    const screen = window.document.getElementById("screen")!
    expect(screen.hidden).toBe(true)
    message({ type: "frame", tabID: "first", data: "", width: 100, height: 100 })
    expect(screen.hidden).toBe(true)
    message({ type: "frame", tabID: "second", data: "", width: 100, height: 100, url: "https://second.test" })
    expect(screen.hidden).toBe(false)
    window.document.getElementById("reload")!.click()
    expect(sent.at(-1)).toMatchObject({ type: "reload", tabID: "second" })
    window.document.getElementById("closetab")!.click()
    expect(sent.at(-1)).toMatchObject({ type: "tab", action: "close", tabID: "second" })
    window.document.getElementById("newtab")!.click()
    expect(sent.at(-1)).toMatchObject({ type: "tab", action: "open" })
  } finally {
    void window.happyDOM.close()
  }
})
