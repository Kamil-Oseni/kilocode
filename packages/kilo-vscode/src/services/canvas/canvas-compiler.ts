// raya_change - Milestone E portable esbuild canvas compiler and artifact storage
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { initialize, transform, type TransformOptions } from "esbuild-wasm"

// raya_change start - esbuild-wasm must be initialized before transform() in the packaged
// Electron extension host. Auto-init (which works in plain Node/Bun) can never signal ready
// there, so create_canvas hung until the backend host timed out at two minutes and the panel
// stayed empty. Initialize once from the wasm copied beside the extension (worker: false keeps
// it on the host thread, avoiding worker_threads restrictions). Dev/test builds where that file
// is absent fall through to auto-init.
let esbuildReady: Promise<void> | undefined
async function ensureEsbuild(): Promise<void> {
  if (esbuildReady) return esbuildReady
  esbuildReady = (async () => {
    const wasm = join(__dirname, "node_modules", "esbuild-wasm", "esbuild.wasm")
    const bytes = await readFile(wasm).catch(() => undefined)
    if (!bytes) return // not packaged (dev/test) — transform() auto-initializes instead
    await initialize({ wasmModule: await WebAssembly.compile(bytes), worker: false }).catch((err) => {
      if (!/more than once|already been/i.test(String((err as Error)?.message ?? err))) throw err
    })
  })().catch((err) => {
    esbuildReady = undefined // let a later build retry initialization
    throw err
  })
  return esbuildReady
}

type CanvasData = Record<string, unknown>
export type CanvasBuild = {
  name: string
  path: string
  bundle?: string
  data: CanvasData
  status: "ready" | "error"
  version: number
  error?: string
}

type Transform = (source: string, options: TransformOptions) => Promise<{ code: string }>

function message(error: unknown) {
  if (error && typeof error === "object" && "errors" in error && Array.isArray(error.errors)) {
    return error.errors
      .map((item: { text?: string; location?: { line?: number; column?: number } }) => {
        const where = item.location?.line ? `${item.location.line}:${(item.location.column ?? 0) + 1}: ` : ""
        return `${where}${item.text ?? "Canvas compilation failed"}`
      })
      .join("\n")
  }
  return error instanceof Error ? error.message : String(error)
}

export class CanvasCompiler {
  private readonly versions = new Map<string, number>()

  constructor(
    private readonly output: string,
    private readonly compile: Transform = transform,
  ) {}

  async create(root: string, name: string, source: string, data: CanvasData): Promise<CanvasBuild> {
    this.validate(name)
    const path = this.source(root, name)
    await mkdir(dirname(path), { recursive: true })
    await Promise.all([writeFile(path, source, "utf8"), this.writeData(root, name, data)])
    return this.build(root, name, source, data)
  }

  async update(root: string, name: string, input: { source?: string; data?: CanvasData }): Promise<CanvasBuild> {
    this.validate(name)
    const path = this.source(root, name)
    const source = input.source ?? (await readFile(path, "utf8"))
    const data = input.data ?? (await this.readData(root, name))
    if (input.source !== undefined) await writeFile(path, source, "utf8")
    if (input.data !== undefined) await this.writeData(root, name, data)
    return this.build(root, name, source, data)
  }

  async rebuild(path: string): Promise<CanvasBuild> {
    const name = this.name(path)
    const root = dirname(dirname(dirname(path)))
    return this.build(root, name, await readFile(path, "utf8"), await this.readData(root, name))
  }

  source(root: string, name: string) {
    return join(root, ".raya", "canvases", `${name}.canvas.tsx`)
  }

  data(root: string, name: string) {
    return join(root, ".raya", "canvases", `${name}.canvas.json`)
  }

  private async build(root: string, name: string, source: string, data: CanvasData): Promise<CanvasBuild> {
    const path = this.source(root, name)
    const version = (this.versions.get(path) ?? 0) + 1
    this.versions.set(path, version)
    try {
      if (/^\s*import\s/m.test(source)) throw new Error("Canvas artifacts cannot import packages; use JSX directly.")
      if (!/\bexport\s+default\b/.test(source))
        throw new Error("Canvas source must default-export one React component.")
      // raya_change - esbuild-wasm must be initialized before transform() in the packaged
      // extension host, and even then a stuck worker/service could hang forever, stalling the
      // whole canvas request until the backend host times out with an empty panel. Bound init +
      // transform together so any hang surfaces as a fast, visible "needs repair" error.
      const result = await this.race(
        this.transform(
          `const React = window.RayaCanvas.React
const { useCallback, useEffect, useMemo, useRef, useState } = React
${source}`,
          {
            loader: "tsx",
            format: "iife",
            globalName: "RayaArtifact",
            target: "es2022",
            jsxFactory: "window.RayaCanvas.React.createElement",
            jsxFragment: "window.RayaCanvas.React.Fragment",
            sourcemap: "inline",
            sourcefile: path,
          },
        ),
      )
      const dir = join(this.output, createHash("sha256").update(root).digest("hex").slice(0, 12))
      const bundle = join(dir, `${name}.${version}.js`)
      await mkdir(dir, { recursive: true })
      await writeFile(bundle, `${result.code}\nwindow.RayaCanvas.mount(RayaArtifact.default);\n`, "utf8")
      return { name, path, bundle, data, status: "ready", version }
    } catch (error) {
      return { name, path, data, status: "error", version, error: message(error) }
    }
  }

  // raya_change - initialize esbuild-wasm (packaged host) before delegating to the transform.
  private async transform(source: string, options: TransformOptions): Promise<{ code: string }> {
    await ensureEsbuild()
    return this.compile(source, options)
  }

  // raya_change - bound esbuild init + transform so a stuck worker cannot hang the request.
  private async race<T>(work: Promise<T>, ms = 15_000): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Canvas compilation timed out after ${ms / 1000}s (esbuild did not respond).`)),
        ms,
      )
    })
    try {
      return await Promise.race([work, guard])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private validate(name: string) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
      throw new Error("Canvas name must be kebab-case using lowercase letters and numbers.")
  }

  private name(path: string) {
    const match = /([^\\/]+)\.canvas\.tsx$/i.exec(path)
    if (!match) throw new Error(`Not a canvas artifact: ${path}`)
    return match[1]!
  }

  private async readData(root: string, name: string): Promise<CanvasData> {
    const raw = await readFile(this.data(root, name), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "{}"
      throw error
    })
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Canvas data must be a JSON object.")
    return value as CanvasData
  }

  private async writeData(root: string, name: string, data: CanvasData) {
    const path = this.data(root, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(data, null, 2), "utf8")
  }
}
