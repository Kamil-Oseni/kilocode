// raya_change - Milestone E portable esbuild canvas compiler and artifact storage
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { transform, type TransformOptions } from "esbuild-wasm"

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
      const result = await this.compile(
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
