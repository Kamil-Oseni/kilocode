// raya_change - Milestone E shared canvas compiler, watcher, panel, and CLI bridge
import { join } from "node:path"
import * as vscode from "vscode"
import type { CanvasRequest, CanvasResult } from "@kilocode/sdk/v2/client"
import type { KiloConnectionService } from "../cli-backend/connection-service"
import { CanvasBridge } from "./canvas-bridge"
import { CanvasCompiler } from "./canvas-compiler"
import { CanvasPanel } from "./canvas-panel"
import { CanvasRefresh } from "./canvas-refresh"

export class CanvasService implements vscode.Disposable {
  readonly panel: CanvasPanel

  private readonly compiler: CanvasCompiler
  private readonly bridge: CanvasBridge
  private readonly refresh: CanvasRefresh
  private readonly watchers = new Map<string, vscode.FileSystemWatcher>()
  private readonly muted = new Map<string, number>()
  private disposed = false

  constructor(connection: KiloConnectionService, context: vscode.ExtensionContext) {
    this.compiler = new CanvasCompiler(join(context.globalStorageUri.fsPath, "canvas-bundles"))
    this.panel = new CanvasPanel(
      vscode.Uri.joinPath(context.extensionUri, "dist", "canvas-runtime.js"),
      context.extensionUri,
    )
    this.refresh = new CanvasRefresh(this.compiler, (build) => this.panel.show(build))
    this.bridge = new CanvasBridge(connection, {
      execute: (request, directory) => this.execute(request, directory),
    })
  }

  restore(panel: vscode.WebviewPanel): void {
    this.panel.restore(panel)
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
    this.refresh.use(directory, request.name)
    const rendered = await this.panel.show(build)
    return {
      operation: request.operation,
      name: rendered.name,
      path: rendered.path,
      status: rendered.status,
      version: rendered.version,
      error: rendered.error,
    }
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
