// raya_change - Milestone E render-from-data, live-refresh, and error-recovery tests
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { build, stop } from "esbuild"
import { stop as stopWasm } from "esbuild-wasm"
import { Window } from "happy-dom"
import { CanvasCompiler, type CanvasBuild } from "../../src/services/canvas/canvas-compiler"
import { CanvasRefresh } from "../../src/services/canvas/canvas-refresh"

const dirs: string[] = []

afterAll(() => {
  stop()
  stopWasm()
}) // raya_change - release native and WASM esbuild services after Bun tests

async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "raya-canvas-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("Raya canvas compiler", () => {
  it("renders a table from host-passed data", async () => {
    const root = await temp()
    const compiler = new CanvasCompiler(join(root, "bundles"))
    const source = `
type Props = { data: { rows: Array<{ name: string; value: number }> } }
export default function Report({ data }: Props) {
  return <table><tbody>{data.rows.map((row) => <tr><td>{row.name}</td><td>{row.value}</td></tr>)}</tbody></table>
}`
    const build = await compiler.create(root, "passed-data", source, {
      rows: [{ name: "Alpha", value: 42 }],
    })

    expect(build.status).toBe("ready")
    const code = await readFile(build.bundle!, "utf8")
    let component: ((props: { data: unknown }) => unknown) | undefined
    const window = {
      RayaCanvas: {
        React: {
          Fragment: "fragment",
          createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
        },
        mount: (value: typeof component) => {
          component = value
        },
      },
    }
    Function("window", code)(window)
    const tree = component?.({ data: build.data })

    expect(JSON.stringify(tree)).toContain("Alpha")
    expect(JSON.stringify(tree)).toContain("42")
    expect(code).toContain("window.RayaCanvas.mount")
  })

  it("refreshes the active canvas after source and data edits", async () => {
    const root = await temp()
    const compiler = new CanvasCompiler(join(root, "bundles"))
    const first = await compiler.create(
      root,
      "live-report",
      `export default function Report({ data }: { data: { value: number } }) { return <p>Before {data.value}</p> }`,
      { value: 1 },
    )
    const rendered: CanvasBuild[] = []
    const refresh = new CanvasRefresh(compiler, async (build) => {
      rendered.push(build)
      return build
    })
    refresh.use(root, "live-report")

    await writeFile(
      first.path,
      `export default function Report({ data }: { data: { value: number } }) { return <p>After {data.value}</p> }`,
      "utf8",
    )
    await refresh.change(first.path)
    await writeFile(compiler.data(root, "live-report"), JSON.stringify({ value: 9 }), "utf8")
    await refresh.change(compiler.data(root, "live-report"))

    expect(rendered).toHaveLength(2)
    expect(rendered[0]!.version).toBeGreaterThan(first.version)
    expect(await readFile(rendered[0]!.bundle!, "utf8")).toContain("After")
    expect(rendered[1]!.data).toEqual({ value: 9 })
  })

  it("reports syntax errors and recovers on the next update", async () => {
    const root = await temp()
    const compiler = new CanvasCompiler(join(root, "bundles"))
    const broken = await compiler.create(
      root,
      "repairable",
      `export default function Broken({ data }: { data: object }) { return <div>{data.}</div> }`,
      {},
    )

    expect(broken.status).toBe("error")
    expect(broken.error).toMatch(/Expected identifier|Unexpected/)

    const fixed = await compiler.update(root, "repairable", {
      source: `export default function Fixed({ data }: { data: { ok: boolean } }) { return <div>{String(data.ok)}</div> }`,
      data: { ok: true },
    })
    expect(fixed.status).toBe("ready")
    expect(fixed.error).toBeUndefined()
    expect(fixed.version).toBeGreaterThan(broken.version)
  })

  it("shows a runtime error in the panel without crashing its data channel", async () => {
    const runtime = await build({
      entryPoints: [join(import.meta.dir, "../../src/services/canvas/canvas-runtime.tsx")],
      bundle: true,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      write: false,
    })
    const window = new Window({ url: "https://canvas.raya.local" })
    window.document.body.innerHTML =
      '<div id="raya-canvas-root"></div><pre id="raya-canvas-error" role="alert" hidden></pre>'
    const messages: unknown[] = []
    Object.assign(window, {
      postMessage: (message: unknown) => messages.push(message),
    })
    const globals = globalThis as Record<string, unknown>
    const scope: Record<string, unknown> = {
      window,
      document: window.document,
      navigator: window.navigator,
      Node: window.Node,
      Element: window.Element,
      HTMLElement: window.HTMLElement,
      MutationObserver: window.MutationObserver,
      requestAnimationFrame: window.requestAnimationFrame.bind(window),
      cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    }
    const previous = new Map(Object.keys(scope).map((key) => [key, globals[key]]))
    const report = console.error
    Object.assign(globals, scope)
    console.error = () => undefined
    try {
      Function(new TextDecoder().decode(runtime.outputFiles[0]!.contents))()
      const host = window as unknown as {
        RayaCanvas: { mount(component: () => never): void }
      }
      host.RayaCanvas.mount(() => {
        throw new Error("deliberate runtime failure")
      })
      window.dispatchEvent(
        new window.MessageEvent("message", {
          data: { source: "raya-canvas-host", type: "data", data: { value: 1 } },
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(window.document.getElementById("raya-canvas-error")?.textContent).toContain("deliberate runtime failure")
      expect(messages).toContainEqual(expect.objectContaining({ type: "runtimeError" }))
      expect(window.document.getElementById("raya-canvas-root")).not.toBeNull()
      await new Promise((resolve) => setTimeout(resolve, 250))
    } finally {
      console.error = report
      for (const [key, value] of previous) {
        if (value === undefined) delete globals[key]
        else globals[key] = value
      }
      window.close()
    }
  })
})
