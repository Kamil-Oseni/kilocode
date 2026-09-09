// raya_change - Milestone E shared canvas compiler, watcher, panel, and CLI bridge
import { dirname, join, resolve } from "node:path"
import * as vscode from "vscode"
import type { CanvasRequest, CanvasResult } from "@kilocode/sdk/v2/client"
import { CanvasBridge, type CanvasConnection } from "./canvas-bridge"
import { CanvasCompiler, type CanvasBuild } from "./canvas-compiler"
import { CanvasPanel } from "./canvas-panel"
import { CanvasRefresh } from "./canvas-refresh"
import { recover } from "./canvas-recovery"

export class CanvasService implements vscode.Disposable {
  readonly panel: CanvasPanel

  private readonly compiler: CanvasCompiler
  private readonly bridge: CanvasBridge
  private readonly refresh: CanvasRefresh
  private readonly watchers = new Map<string, vscode.FileSystemWatcher>()
  private readonly muted = new Map<string, number>()
  private disposed = false
  private generation = 0

  constructor(connection: CanvasConnection, context: vscode.ExtensionContext) {
    this.compiler = new CanvasCompiler(join(context.globalStorageUri.fsPath, "canvas-bundles"))
    this.panel = new CanvasPanel(
      vscode.Uri.joinPath(context.extensionUri, "dist", "canvas-runtime.js"),
      context.extensionUri,
    )
    this.panel.onFailure((build) => {
      const ticket = ++this.generation
      void this.repair(build, ticket).catch((error) => {
        console.error("[Raya] Canvas runtime recovery failed:", error)
        void vscode.window.showErrorMessage(
          "Canvas recovery could not finish. The saved artifact and draft have been retained.",
        )
      })
    })
    this.refresh = new CanvasRefresh(this.compiler, (build) => this.render(build))
    this.bridge = new CanvasBridge(connection, {
      execute: (request, directory) => this.execute(request, directory),
    })
  }

  private async repair(build: CanvasBuild, ticket: number) {
    let displayed = build
    const current = () => !this.disposed && ticket === this.generation && this.panel.owns(displayed)
    const root = dirname(dirname(dirname(build.path)))
    const files = [build.path, this.compiler.data(root, build.name)]
    for (const path of files) this.muted.set(path, Infinity)
    const previous = await this.compiler
      .rollback(build, current, (path) => this.writable(path))
      .finally(() => {
        for (const path of files) this.muted.set(path, Date.now() + 1_000)
      })
    if (!current()) return
    if (previous) {
      displayed = previous
      displayed = await this.panel.show(previous)
    }
    if (!current()) return
    await recover({
      compiler: this.compiler,
      build: {
        ...build,
        error: [
          build.error?.slice(0, 400) ?? "Canvas runtime failed.",
          previous && displayed.status === "error"
            ? `The earlier saved version also failed: ${displayed.error?.slice(0, 400) ?? "Unknown runtime error."}`
            : previous?.warning,
        ]
          .filter(Boolean)
          .join("\n"),
      },
      previous: !!previous && displayed.status === "ready",
      current,
      render: (candidate) => this.render(candidate),
    })
  }

  private writable(path: string) {
    const normalize = (value: string) => (process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value))
    return !vscode.workspace.textDocuments.some(
      (document) =>
        document.isDirty && document.uri.scheme === "file" && normalize(document.uri.fsPath) === normalize(path),
    )
  }

  async restore(panel: vscode.WebviewPanel, state?: unknown): Promise<void> {
    const ticket = ++this.generation
    this.panel.restore(panel)
    if (
      !state ||
      typeof state !== "object" ||
      !("root" in state) ||
      !("name" in state) ||
      typeof state.root !== "string" ||
      typeof state.name !== "string"
    )
      return
    try {
      const build = await this.compiler.restore(state.root, state.name)
      if (!build || this.disposed || ticket !== this.generation) return
      this.watch(state.root)
      this.refresh.use(state.root, state.name)
      const rendered = await this.panel.show(build)
      if (rendered.status === "error" && ticket === this.generation && this.panel.owns(build))
        await this.repair(rendered, ticket)
      if (rendered.status === "ready" && build.warning && ticket === this.generation && this.panel.owns(build))
        void vscode.window.showWarningMessage(build.warning)
    } catch (error) {
      console.error("[Raya] Could not restore the saved canvas:", error)
      void vscode.window.showErrorMessage(
        "The saved canvas could not be restored. Its saved revision has been retained.",
      )
    }
  }

  // raya_change - route Design Mode element picks to the chat composer.
  onDesignPick(handler: (text: string) => void): void {
    this.panel.onDesignPick(handler)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.bridge.dispose()
    this.panel.dispose()
    for (const watcher of this.watchers.values()) watcher.dispose()
    this.watchers.clear()
  }

  private async execute(request: CanvasRequest, directory: string): Promise<CanvasResult> {
    this.assertRoot(directory)
    const ticket = ++this.generation
    this.watch(directory)
    const path = this.compiler.source(directory, request.name)
    this.muted.set(path, Date.now() + 1_000)
    this.muted.set(this.compiler.data(directory, request.name), Date.now() + 1_000)
    const build =
      request.operation === "create"
        ? await this.compiler.create(directory, request.name, request.source, request.data)
        : await this.compiler.update(directory, request.name, {
            source: request.source,
            data: request.data,
          })
    if (ticket === this.generation) this.refresh.use(directory, request.name)
    const rendered =
      ticket === this.generation
        ? await this.render(build)
        : { ...build, status: "error" as const, error: "Canvas request was superseded by a newer request." }
    return {
      operation: request.operation,
      name: rendered.name,
      path: rendered.path,
      status: rendered.status,
      version: rendered.version,
      error: rendered.error,
    }
  }

  private async render(build: CanvasBuild): Promise<CanvasBuild> {
    if (!this.compiler.owns(build))
      return { ...build, status: "error", error: "Canvas candidate was superseded before rendering." }
    const ticket = ++this.generation
    const rendered = await this.panel.show(build)
    if (ticket !== this.generation)
      return { ...build, status: "error", error: "Canvas render was superseded or failed after acknowledgement." }
    if (rendered.status === "ready") {
      await this.compiler.commit(rendered, (path) => this.writable(path))
      if (rendered.warning && ticket === this.generation) void vscode.window.showWarningMessage(rendered.warning)
    }
    if (rendered.status === "error" && this.panel.owns(build) && ticket === this.generation) {
      void this.repair(rendered, ticket).catch((error) => {
        console.error("[Raya] Canvas recovery failed:", error)
        void vscode.window.showErrorMessage(
          "Canvas recovery could not finish. The saved artifact and draft have been retained.",
        )
      })
    }
    return rendered
  }

  private watch(root: string) {
    if (this.watchers.has(root)) return
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, ".raya/canvases/*.{canvas.tsx,canvas.json}"),
    )
    const refresh = (uri: vscode.Uri) => void this.reload(uri.fsPath)
    watcher.onDidChange(refresh)
    watcher.onDidCreate(refresh)
    this.watchers.set(root, watcher)
  }

  private async reload(path: string) {
    if ((this.muted.get(path) ?? 0) > Date.now()) return
    try {
      await this.refresh.change(path)
    } catch (error) {
      console.error("[Kilo New] CanvasService: live refresh failed:", error)
    }
  }

  private assertRoot(directory: string) {
    if (!directory) throw new Error("Canvas requests require a workspace directory")
    if (this.disposed) throw new Error("Canvas service is disposed")
  }
}
