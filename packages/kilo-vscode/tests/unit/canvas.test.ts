// raya_change - Milestone E render-from-data, live-refresh, and error-recovery tests
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
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
  it.each(["saved", "unsaved"])("preserves %s edits made before a rendered candidate is promoted", async (kind) => {
    const root = await temp()
    const compiler = new CanvasCompiler(join(root, "bundles"))
    const source = "export default function Report() { return <p>Original</p> }"
    const first = await compiler.create(root, "promotion", source, { value: 1 })
    await compiler.commit(first)
    const next = await compiler.create(root, "promotion", "export default function Report() { return <p>New</p> }", {
      value: 2,
    })
    if (kind === "saved") await writeFile(first.path, "manual edits made during render")
    await compiler.commit(next, () => kind !== "unsaved")
    expect(next.warning).toContain("local edits")
    expect(await readFile(first.path, "utf8")).toBe(kind === "saved" ? "manual edits made during render" : source)
    expect(JSON.parse(await readFile(compiler.data(root, "promotion"), "utf8"))).toEqual({ value: 1 })
    const restored = await compiler.restore(root, "promotion")
    expect(restored?.revision).toBe(next.revision)
    expect(restored?.data).toEqual({ value: 2 })
    expect(restored?.warning).toContain("differs from its editable source/data files")
  })

  it("rolls back a late failure after restart while retaining its inspectable draft", async () => {
    const root = await temp()
    const output = join(root, "bundles")
    const compiler = new CanvasCompiler(output)
    const first = await compiler.create(
      root,
      "rollback",
      "export default function Report() { return <p>Previous</p> }",
      { value: 1 },
    )
    await compiler.commit(first)
    const next = await compiler.create(root, "rollback", "export default function Report() { return <p>Later</p> }", {
      value: 2,
    })
    await compiler.commit(next)
    const reopened = new CanvasCompiler(output)
    expect((await reopened.restore(root, "rollback"))?.revision).toBe(next.revision)
    const restored = await reopened.rollback({ ...next, status: "error", error: "late error" }, () => true)
    expect(restored?.revision).toBe(first.revision)
    expect(restored?.data).toEqual({ value: 1 })
    expect(await readFile(first.path, "utf8")).toContain("Previous")
    expect(JSON.parse(await readFile(compiler.data(root, "rollback"), "utf8"))).toEqual({ value: 1 })
    expect(restored?.warning).toBeUndefined()
    expect((await reopened.draft(next)).data).toEqual({ value: 2 })
    expect((await new CanvasCompiler(output).restore(root, "rollback"))?.revision).toBe(first.revision)
    const last = await reopened.create(root, "rollback", "export default function Report() { return <p>Newest</p> }", {
      value: 3,
    })
    await reopened.commit(last)
    await reopened.rollback(next, () => true)
    expect((await reopened.restore(root, "rollback"))?.revision).toBe(last.revision)
    await reopened.rollback(last, () => false)
    expect((await reopened.restore(root, "rollback"))?.revision).toBe(last.revision)
  })

  it.each(["saved", "unsaved"])(
    "preserves %s manual edits while rolling back the authoritative canvas",
    async (kind) => {
      const root = await temp()
      const compiler = new CanvasCompiler(join(root, "bundles"))
      const first = await compiler.create(
        root,
        "manual",
        "export default function Report() { return <p>Earlier</p> }",
        { value: 1 },
      )
      await compiler.commit(first)
      const source = "export default function Report() { return <p>Later</p> }"
      const next = await compiler.create(root, "manual", source, { value: 2 })
      await compiler.commit(next)
      if (kind === "saved") await writeFile(next.path, "manual source edits")
      const restored = await compiler.rollback(
        next,
        () => true,
        () => kind !== "unsaved",
      )
      expect(restored?.revision).toBe(first.revision)
      expect(restored?.warning).toContain("Edited source/data files were retained")
      expect(await readFile(next.path, "utf8")).toBe(kind === "saved" ? "manual source edits" : source)
      expect(JSON.parse(await readFile(compiler.data(root, "manual"), "utf8"))).toEqual({ value: 2 })
    },
  )

  it("rejects malformed saved records without overwriting the bundle or editable artifact", async () => {
    const root = await temp()
    const compiler = new CanvasCompiler(join(root, "bundles"))
    const source = "export default function Report() { return <p>Saved</p> }"
    const first = await compiler.create(root, "validated", source, { value: 1 })
    await compiler.commit(first)
    const manifest = join(dirname(first.bundle!), "validated.current.json")
    const raw = await readFile(manifest, "utf8")
    const saved = JSON.parse(raw)
    const invalid = [
      "",
      "{",
      "null",
      "[]",
      ...[
        { ...saved, code: "" },
        ...[
          { data: null },
          { data: [] },
          { data: "invalid" },
          { version: 0 },
          { version: 1.5 },
          { version: Number.MAX_SAFE_INTEGER + 1 },
          { revision: "-".repeat(36) },
          { name: "different" },
          { status: "error" },
        ].map((build) => ({ ...saved, build: { ...saved.build, ...build } })),
      ].map((value) => JSON.stringify(value)),
    ]
    await writeFile(first.bundle!, "bundle sentinel")
    for (const value of invalid) {
      await writeFile(manifest, value)
      await expect(compiler.restore(root, "validated")).rejects.toThrow("Saved canvas revision")
      expect(await readFile(manifest, "utf8")).toBe(value)
      expect(await readFile(first.bundle!, "utf8")).toBe("bundle sentinel")
      expect(await readFile(first.path, "utf8")).toBe(source)
    }
    await writeFile(
      manifest,
      JSON.stringify({
        ...saved,
        build: { ...saved.build, path: "untrusted", bundle: "untrusted", error: "obsolete" },
      }),
    )
    const restored = await compiler.restore(root, "validated")
    expect(restored?.path).toBe(first.path)
    expect(restored?.bundle).toBe(first.bundle)
    expect(restored?.error).toBeUndefined()
    expect(await readFile(first.bundle!, "utf8")).toBe(saved.code)
  })

  it("preserves a rendered revision across failed compilation and a compiler restart", async () => {
    const root = await temp()
    const output = join(root, "bundles")
    const compiler = new CanvasCompiler(output)
    const source = `export default function Report() { return <p>Saved result</p> }`
    const first = await compiler.create(root, "durable", source, { value: 1 })
    await compiler.commit(first)
    const broken = await compiler.update(root, "durable", {
      source: "export default function Broken( {",
      data: { value: 2 },
    })
    expect(broken.status).toBe("error")
    expect(await readFile(first.path, "utf8")).toBe(source)
    expect(JSON.parse(await readFile(compiler.data(root, "durable"), "utf8"))).toEqual({ value: 1 })
    const restored = await new CanvasCompiler(output).restore(root, "durable")
    expect(restored?.revision).toBe(first.revision)
    expect(restored?.data).toEqual({ value: 1 })
    expect(await readFile(restored!.bundle!, "utf8")).toContain("Saved result")
  })

  it("does not promote runtime failures or superseded candidates", async () => {
    const root = await temp()
    const compiler = new CanvasCompiler(join(root, "bundles"))
    const first = await compiler.create(root, "guarded", `export default function Report() { return <p>First</p> }`, {})
    await compiler.commit(first)
    const next = await compiler.update(root, "guarded", {
      source: `export default function Report() { throw new Error("runtime"); }`,
    })
    await expect(compiler.commit({ ...next, status: "error", error: "runtime" })).rejects.toThrow()
    expect((await compiler.restore(root, "guarded"))?.revision).toBe(first.revision)
    const last = await compiler.update(root, "guarded", {
      source: `export default function Report() { return <p>Last</p> }`,
    })
    await expect(compiler.commit(next)).rejects.toThrow("superseded")
    await compiler.commit(last)
    expect((await compiler.restore(root, "guarded"))?.revision).toBe(last.revision)
  })

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
    await compiler.commit(first)
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
