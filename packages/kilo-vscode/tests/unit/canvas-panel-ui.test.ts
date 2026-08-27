// raya_change - Milestone E sandbox and beside-chat panel contracts
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const panel = readFileSync(join(import.meta.dir, "../../src/services/canvas/canvas-panel.ts"), "utf8")
const runtime = readFileSync(join(import.meta.dir, "../../src/services/canvas/canvas-runtime.tsx"), "utf8")
const service = readFileSync(join(import.meta.dir, "../../src/services/canvas/canvas-service.ts"), "utf8")

describe("Raya canvas panel contracts", () => {
  it("opens beside chat with a restrictive script and network sandbox", () => {
    expect(panel).toContain("vscode.ViewColumn.Beside")
    expect(panel).toContain(`default-src 'none'`)
    expect(panel).toContain('sandbox="allow-scripts"')
    expect(panel).not.toContain("allow-same-origin")
    expect(panel).toContain(`script-src 'nonce-\${nonce}'`)
    expect(panel).not.toContain("connect-src")
  })

  it("delivers host data and reports runtime errors without replacing the panel", () => {
    expect(panel).toContain(`postMessage({ type: "data", data: this.current?.data ?? {} })`)
    expect(panel).toContain(`message.type === "runtimeError"`)
    expect(panel).toContain(`event.source === frame.contentWindow`)
    expect(runtime).toContain(`post({ type: "runtimeError", error: message })`)
    expect(runtime).toContain(`source !== "raya-canvas-host"`)
    expect(runtime).toContain("class Boundary extends Component")
    expect(runtime).toContain('document.getElementById("raya-canvas-error")')
  })

  it("watches source and data artifacts for automatic refresh", () => {
    expect(service).toContain(".raya/canvases/*.{canvas.tsx,canvas.json}")
    expect(service).toContain("watcher.onDidChange(refresh)")
    expect(service).toContain("await this.refresh.change(path)")
  })
})
