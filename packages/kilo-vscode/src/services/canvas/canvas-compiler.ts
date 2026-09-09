// raya_change - Milestone E portable esbuild canvas compiler and artifact storage
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { initialize, transform, type TransformOptions } from "esbuild-wasm"
import { z } from "zod"
import { prune } from "./canvas-retention"
import { reconcile } from "./canvas-projection"

// raya_change start - esbuild-wasm must be initialized before transform() in the packaged
// Electron extension host. Its default async service spins up a worker to talk to the wasm, and
// that worker never signals ready inside the extension host, so create_canvas hung until the
// backend host timed out at two minutes and the panel stayed empty. `worker: false` runs the wasm
// synchronously on the host thread instead, which is what makes it reliable here. (`wasmModule` is
// a browser-only option and throws in Node/Electron, so we let esbuild locate its own wasm.)
// Initialize once; a genuine failure is rethrown so a later build can retry.
let esbuildReady: Promise<void> | undefined
async function ensureEsbuild(): Promise<void> {
  if (esbuildReady) return esbuildReady
  esbuildReady = initialize({ worker: false }).catch((err) => {
    // A prior transform may have already auto-initialized the singleton service; that specific
    // case is safe to treat as ready. Anything else is a real failure worth surfacing.
    if (/more than once|already/i.test(String((err as Error)?.message ?? err))) return
    esbuildReady = undefined
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
  revision?: string
  warning?: string
}

type Transform = (source: string, options: TransformOptions) => Promise<{ code: string }>

const identity = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
const record = z.object({
  source: z.string(),
  code: z.string().min(1),
  build: z.object({
    name: z.string(),
    revision: identity,
    status: z.literal("ready"),
    version: z.number().int().positive().safe(),
    data: z.record(z.unknown()),
  }),
})
const manifest = record.extend({ previous: record.optional() })

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
  private readonly latest = new Map<string, string>()
  private readonly candidates = new Map<
    string,
    {
      root: string
      source: string
      build: CanvasBuild
      code?: string
      files: { path: string; before: string | undefined; after: string }[]
    }
  >()
  private readonly commits = new Map<string, Promise<void>>()
  private readonly active = new Set<string>()

  constructor(
    private readonly output: string,
    private readonly compile: Transform = transform,
  ) {}

  async create(root: string, name: string, source: string, data: CanvasData): Promise<CanvasBuild> {
    this.validate(name)
    const path = this.source(root, name)
    await mkdir(dirname(path), { recursive: true })
    return this.build(root, name, source, data)
  }

  async update(root: string, name: string, input: { source?: string; data?: CanvasData }): Promise<CanvasBuild> {
    this.validate(name)
    const path = this.source(root, name)
    const source = input.source ?? (await readFile(path, "utf8"))
    const data = input.data ?? (await this.readData(root, name))
    return this.build(root, name, source, data)
  }

  /** Promote only a successful render of the latest candidate. */
  commit(build: CanvasBuild, writable: (path: string) => boolean = () => true): Promise<void> {
    return this.queue(build.path, async () => {
      await this.save(build, writable)
      await this.clean(dirname(dirname(dirname(build.path))), build.name)
    })
  }

  private queue(path: string, work: () => Promise<void>): Promise<void> {
    const prior = this.commits.get(path) ?? Promise.resolve()
    const next = prior.then(work, work).finally(() => {
      if (this.commits.get(path) === next) this.commits.delete(path)
    })
    this.commits.set(path, next)
    return next
  }

  private async clean(root: string, name: string) {
    try {
      const raw = await readFile(this.manifest(root, name), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      const saved = raw === undefined ? undefined : manifest.parse(JSON.parse(raw))
      if (saved && saved.build.name !== name) throw new Error("Saved canvas name does not match its cache.")
      await prune(
        this.directory(root),
        name,
        (revision) =>
          revision === saved?.build.revision ||
          revision === saved?.previous?.build.revision ||
          revision === this.latest.get(this.source(root, name)) ||
          this.active.has(revision),
      )
    } catch (error) {
      // Cleanup is best effort; uncertain saved identity must retain recovery files.
      console.error("[Raya] Canvas cache cleanup skipped:", error)
    }
  }

  private async save(build: CanvasBuild, writable: (path: string) => boolean): Promise<void> {
    if (this.latest.get(build.path) !== build.revision)
      throw new Error("Canvas candidate was superseded before saving.")
    const candidate = build.revision && this.candidates.get(build.revision)
    if (!candidate || build.status !== "ready" || !candidate.code)
      throw new Error("Canvas has no rendered candidate to save.")
    const target = this.manifest(candidate.root, build.name)
    const raw = await readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    const previous = raw === undefined ? undefined : record.parse(JSON.parse(raw))
    if (previous && previous.build.name !== build.name) throw new Error("Saved canvas name does not match.")
    const temp = `${target}.${randomUUID()}.tmp`
    await mkdir(dirname(target), { recursive: true })
    try {
      await writeFile(
        temp,
        JSON.stringify({ source: candidate.source, code: candidate.code, build: candidate.build, previous }),
        {
          flag: "wx",
        },
      )
      if (this.latest.get(build.path) !== build.revision)
        throw new Error("Canvas candidate was superseded before saving.")
      await rename(temp, target)
    } finally {
      await unlink(temp).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
      })
    }
    const projected = await reconcile(candidate.files, () => this.owns(build), writable).catch((error) => {
      console.error("[Raya] Canvas editable files could not be synchronized:", error)
      return false
    })
    if (!projected)
      build.warning =
        "The canvas was saved, but source/data files may differ because local edits or a file error prevented synchronization."
    this.candidates.delete(build.revision!)
  }

  owns(build: CanvasBuild): boolean {
    return this.latest.get(build.path) === build.revision
  }

  /** Roll back a failed saved revision without replacing a newer request's manifest. */
  async rollback(
    build: CanvasBuild,
    current: () => boolean,
    writable: (path: string) => boolean = () => true,
  ): Promise<CanvasBuild | undefined> {
    this.validate(build.name)
    const root = dirname(dirname(dirname(build.path)))
    let preserved = false
    await this.queue(build.path, async () => {
      if (!current()) return
      const target = this.manifest(root, build.name)
      const raw = await readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (raw === undefined) return
      const saved = manifest.parse(JSON.parse(raw))
      if (saved.build.name !== build.name || (saved.previous && saved.previous.build.name !== build.name))
        throw new Error("Saved canvas name does not match.")
      if (saved.build.revision !== build.revision || !saved.previous) return
      const temp = `${target}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, JSON.stringify(saved.previous), { flag: "wx" })
        if (!current()) return
        await rename(temp, target)
        preserved = !(await reconcile(
          [
            { path: this.source(root, build.name), before: saved.source, after: saved.previous.source },
            {
              path: this.data(root, build.name),
              before: JSON.stringify(saved.build.data, null, 2),
              after: JSON.stringify(saved.previous.build.data, null, 2),
            },
          ],
          current,
          writable,
        ).catch((error) => {
          console.error("[Raya] Canvas editable files could not be reconciled:", error)
          return false
        }))
      } finally {
        await unlink(temp).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
        })
      }
    })
    if (!current()) return
    const saved = await this.restore(root, build.name)
    if (!saved || saved.revision === build.revision) return
    return {
      ...saved,
      warning: preserved
        ? "The earlier canvas is displayed. Edited source/data files were retained and may differ from this saved version."
        : saved.warning,
    }
  }

  /** Load the failed candidate for inspection or an explicit retry. */
  async draft(build: CanvasBuild) {
    const path = this.draftPath(build)
    const root = dirname(dirname(dirname(build.path)))
    const value = JSON.parse(await readFile(path, "utf8")) as { source?: unknown; data?: unknown }
    if (
      !value ||
      typeof value.source !== "string" ||
      !value.data ||
      typeof value.data !== "object" ||
      Array.isArray(value.data)
    )
      throw new Error("Canvas draft must contain source text and a data object.")
    return { path, root, source: value.source, data: value.data as CanvasData }
  }

  /** Inspection must remain available even when the editable JSON cannot be parsed. */
  draftPath(build: CanvasBuild) {
    this.validate(build.name)
    if (!identity.safeParse(build.revision).success) throw new Error("Canvas draft identity is invalid.")
    const root = dirname(dirname(dirname(build.path)))
    return join(this.directory(root), `${build.name}.${build.revision}.draft.json`)
  }

  /** Recover the saved source, data and executable bundle without recompilation. */
  async restore(root: string, name: string): Promise<CanvasBuild | undefined> {
    this.validate(name)
    const raw = await readFile(this.manifest(root, name), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (raw === undefined) return
    const parsed = record.safeParse(
      (() => {
        try {
          return JSON.parse(raw) as unknown
        } catch {
          throw new Error("Saved canvas revision contains invalid JSON. Its saved files have been retained.")
        }
      })(),
    )
    if (!parsed.success || parsed.data.build.name !== name)
      throw new Error("Saved canvas revision is invalid. Its saved files have been retained.")
    const saved = parsed.data
    const path = this.source(root, name)
    const bundle = join(this.directory(root), `${name}.${saved.build.revision}.js`)
    await mkdir(dirname(bundle), { recursive: true })
    await writeFile(bundle, saved.code, "utf8")
    const files = await Promise.all(
      [path, this.data(root, name)].map((file) =>
        readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          console.error("[Raya] Could not compare editable canvas files:", error)
          return undefined
        }),
      ),
    )
    const warning =
      files[0] !== saved.source || files[1] !== JSON.stringify(saved.build.data, null, 2)
        ? "This saved canvas differs from its editable source/data files, or those files could not be read. Local files have been retained; review them before editing this canvas."
        : undefined
    return { ...saved.build, path, bundle, warning }
  }

  private directory(root: string) {
    return join(this.output, createHash("sha256").update(root).digest("hex").slice(0, 12))
  }

  private manifest(root: string, name: string) {
    return join(this.directory(root), `${name}.current.json`)
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
    const revision = randomUUID()
    this.latest.set(path, revision)
    for (const [id, candidate] of this.candidates) {
      if (candidate.build.path === path) this.candidates.delete(id)
    }
    const files = await Promise.all(
      [
        { path, after: source },
        { path: this.data(root, name), after: JSON.stringify(data, null, 2) },
      ].map(async (file) => ({
        ...file,
        before: await readFile(file.path, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        }),
      })),
    )
    const dir = this.directory(root)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${name}.${revision}.draft.json`), JSON.stringify({ source, data }), { flag: "wx" })
    this.active.add(revision)
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
      const bundle = join(dir, `${name}.${revision}.js`)
      await mkdir(dir, { recursive: true })
      const code = `${result.code}\nwindow.RayaCanvas.mount(RayaArtifact.default);\n`
      await writeFile(bundle, code, { flag: "wx" })
      const build: CanvasBuild = { name, path, bundle, data, status: "ready", version, revision }
      if (this.owns(build)) this.candidates.set(revision, { root, source, build, code, files })
      return build
    } catch (error) {
      return { name, path, data, status: "error", version, revision, error: message(error) }
    } finally {
      this.active.delete(revision)
      await this.queue(path, () => this.clean(root, name))
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
}
