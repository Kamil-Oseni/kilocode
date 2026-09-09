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
    const profile = {
      profileID: "profile_seen",
      directory: "<img src=x onerror=bad()>",
      status: "locked",
      message: "Close the other browser and retry.",
      authentication: { source: "live", login: "unverified" },
    }
    message({
      type: "profile",
      profile,
      captures: [
        {
          id: "capture_seen",
          name: "<img src=x onerror=bad()>",
          status: "expired",
          expiresAt: 0,
          origins: [],
          domains: ["example.test"],
        },
      ],
    })
    const captures = window.document.getElementById("captures")!
    expect(captures.textContent).toContain("<img src=x onerror=bad()>")
    expect(captures.querySelector("img")).toBeNull()
    expect(captures.querySelector("button")!.disabled).toBe(true)
    expect(window.document.getElementById("profile-state")!.textContent).toContain("login unverified")
    expect(window.document.getElementById("identity")!.hasAttribute("open")).toBe(true)
    captures.querySelectorAll("button")[1].click()
    expect(sent.at(-1)).toMatchObject({
      type: "auth",
      action: "delete",
      profileID: "profile_seen",
      captureID: "capture_seen",
    })
    window.document.getElementById("retry-browser")!.click()
    expect(sent.at(-1)).toMatchObject({ type: "profile", action: "retry" })
    message({ type: "profile", profile: { ...profile, status: "ready" }, captures: [] })
    message({
      type: "uploads",
      uploads: [
        {
          id: "upload_seen",
          destination: "https://example.test/<img>",
          files: [{ name: "<img src=x onerror=bad()>", bytes: 42 }],
          status: "staging",
        },
      ],
    })
    const uploads = window.document.getElementById("uploads")!
    expect(uploads.textContent).toContain("<img src=x onerror=bad()>")
    expect(uploads.querySelector("img")).toBeNull()
    uploads.querySelector("button")!.click()
    expect(sent.at(-1)).toMatchObject({ type: "upload", action: "cancel", uploadID: "upload_seen" })
    message({
      type: "uploads",
      uploads: [
        {
          id: "upload_seen",
          destination: "https://example.test/form",
          files: [{ name: "report.pdf", bytes: 42 }],
          status: "selected",
        },
      ],
    })
    expect(uploads.textContent).toContain("verify the upload result on the page")
    expect(uploads.querySelector("button")).toBeNull()
    const inventory = (selected: string) =>
      message({
        type: "tabs",
        tabs: [
          { id: "first", title: "First", selected: selected === "first" },
          { id: "second", title: "Second", selected: selected === "second", openerID: "first" },
        ],
      })
    message({
      type: "downloads",
      offset: 0,
      transfers: [{ id: "download_seen", filename: "<img src=x onerror=bad()>", status: "completed", bytes: 12 }],
    })
    const downloads = window.document.getElementById("downloads")!
    expect(downloads.textContent).toContain("<img src=x onerror=bad()>")
    expect(downloads.querySelector("img")).toBeNull()
    downloads.querySelector("button")!.click()
    expect(sent.at(-1)).toMatchObject({ type: "download", action: "reveal", transferID: "download_seen" })
    downloads.querySelectorAll("button")[1]!.click()
    expect(sent.at(-1)).toMatchObject({ type: "download", action: "save", transferID: "download_seen" })
    message({
      type: "downloads",
      offset: 0,
      transfers: [{ id: "pending_seen", filename: "report", status: "receiving" }],
    })
    downloads.querySelector("button")!.click()
    expect(sent.at(-1)).toMatchObject({ type: "download", action: "cancel", transferID: "pending_seen" })
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
    message({ type: "state", state: { control: "agent", busy: true } })
    message({
      type: "dialogs",
      dialogs: [
        {
          id: "observed",
          tabID: "first",
          type: "prompt",
          status: "open",
          message: "<script>bad()</script>",
          defaultValue: "Default",
          truncated: false,
        },
      ],
      operations: [],
    })
    const card = window.document.querySelector('[role="dialog"]')!
    expect(card.textContent).toContain("<script>bad()</script>")
    expect(card.querySelector("script")).toBeNull()
    const prompt = card.querySelector("input")!
    prompt.value = "Edited"
    const accept = card.querySelector("button")!
    expect(accept.disabled).toBe(false)
    accept.click()
    expect(sent.at(-1)).toMatchObject({
      type: "dialog",
      tabID: "first",
      dialogID: "observed",
      action: "accept",
      text: "Edited",
    })
    expect(accept.disabled).toBe(true)
    message({ type: "dialogs", dialogs: [], operations: [] })
    expect(window.document.querySelector('[role="dialog"]')).toBeNull()
  } finally {
    void window.happyDOM.close()
  }
})
