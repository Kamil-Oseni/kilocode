import * as vscode from "vscode"
import { manifest, metadata } from "./manifest"
import { BrainSettings } from "./settings"
import { BrainService } from "./service"
import { Failure } from "./client"
import type { BrainRequest, BrainResponse } from "../shared/second-brain"
import { BrainControl, type Review } from "./control"
import { BrainClient } from "./client"
import { join } from "./join"
import { Control, parseCatalog } from "./control/index"
import { drain, register } from "./retirement"
import { descriptor, selection, type Descriptor } from "./managed/descriptor"

const services = new WeakMap<
  vscode.ExtensionContext,
  { settings: BrainSettings; service: BrainService; control: BrainControl }
>()
const catalogKey = "raya.secondBrain.control.catalog"

export function drainBrain() {
  return drain()
}

export class BrainHost {
  private readonly settings: BrainSettings
  private readonly service: BrainService
  private readonly control: BrainControl
  private current: { id: string; owner: object } | undefined

  constructor(private readonly context: vscode.ExtensionContext) {
    const existing = services.get(context)
    this.settings = existing?.settings ?? new BrainSettings(context.globalState, context.secrets)
    this.service = existing?.service ?? new BrainService(this.settings, context.extensionPath)
    this.control =
      existing?.control ??
      new BrainControl(this.service, this.settings, async (setup) => {
        const saved = context.globalState.get<{ root: string; catalog: unknown }>(catalogKey)
        if (!saved || saved.root !== setup.root)
          throw new Failure("control_setup_required", "Select a reviewed Memory control catalog", 0)
        const catalog = parseCatalog(saved.catalog)
        if (
          catalog.version !== setup.version ||
          Object.entries(setup.source_sha256).some(([name, hash]) => catalog.source_sha256[name] !== hash)
        )
          throw new Failure("identity_mismatch", "Control and search releases differ", 0)
        return Control.open(setup.root, catalog, context.extensionPath)
      })
    if (existing) return
    services.set(context, { settings: this.settings, service: this.service, control: this.control })
    const close = () => join([this.control.dispose(), this.service.dispose(), Control.drain()])
    register(close)
    context.subscriptions.push({
      dispose: () => {
        void close().catch(() => console.warn("[Kilo New] Memory coordinator cleanup failed"))
      },
    })
  }

  async accept(message: Record<string, unknown>, post: (value: BrainResponse) => void) {
    if (message.type !== "secondBrain") return false
    if (typeof message.id !== "string") return true
    if (message.action === "search" && typeof message.query === "string")
      await this.handle({ type: "secondBrain", action: "search", id: message.id, query: message.query }, post)
    if (message.action === "cancel" && typeof message.target === "string")
      await this.handle({ type: "secondBrain", action: "cancel", id: message.id, target: message.target }, post)
    if (
      ["state", "setup", "check", "disconnect", "controlSetup", "review", "sync", "disable"].includes(
        String(message.action),
      )
    )
      await this.handle(
        {
          type: "secondBrain",
          action: message.action as Exclude<BrainRequest["action"], "search" | "cancel">,
          id: message.id,
        },
        post,
      )
    return true
  }

  private async handle(message: BrainRequest, post: (value: BrainResponse) => void) {
    if (typeof message.id !== "string" || !/^[a-z0-9-]{1,80}$/i.test(message.id)) return
    const send = (state: BrainResponse["state"]) =>
      post({ type: "secondBrainState", id: message.id, state: { ...state, control: this.control.snapshot() } })
    try {
      if (message.action === "setup") await this.setup()
      if (message.action === "disconnect") {
        await this.control.stop()
        await this.service.disconnect()
      }
      if (message.action === "review") await this.review()
      if (message.action === "controlSetup") await this.catalog()
      if (message.action === "sync")
        await this.control.sync(
          (value) => this.confirm(value, "Sync now"),
          async (expected, signal, close) => {
            const cfg = await this.settings.load()
            if (!cfg) throw new Error("Memory setup required")
            if (cfg.setup.version === 2) {
              await this.service.sync(expected, signal, close)
              return
            }
            const client = new BrainClient(cfg.key, cfg.setup)
            try {
              await client.sync(expected, signal, async (request) => {
                await this.settings.record({
                  format: "raya.memory.control.uncertainty",
                  version: 1,
                  root: cfg.setup.root,
                  request,
                })
              })
            } catch (error) {
              // Transport settlement is not downstream retirement: preserve a fresh backend refusal.
              const health = await client.health().then(
                () => undefined,
                (cause: unknown) => cause,
              )
              if (health !== undefined)
                throw new AggregateError([error, health], "Memory sync and retirement status failed")
              throw error
            }
          },
        )
      if (message.action === "disable") await this.control.pause((value) => this.confirm(value, "Disable policy"))
      if (message.action === "cancel" && this.current?.id === message.target)
        await this.service.stop(this.current.owner)
      if (message.action === "search") {
        if (typeof message.query !== "string" || !message.query.trim() || message.query.length > 8000)
          throw new Error("Invalid query")
        const owner = {}
        this.current = { id: message.id, owner }
        await this.service.run(message.query, send, owner)
        return
      }
      if (message.action === "check") {
        const owner = {}
        this.current = { id: message.id, owner }
        await this.service.run(undefined, send, owner)
        return
      }
      send(await this.service.status())
    } catch (err) {
      const configured = await this.settings.load().then(
        (value) => !!value,
        () => false,
      )
      send({
        configured,
        status: "unavailable",
        code: err instanceof Failure ? err.code : "setup_invalid",
        results: [],
      })
    }
  }

  private async setup() {
    await this.control.stop()
    const selected = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "Memory setup": ["json"] },
      title: "Select a reviewed local Memory setup manifest",
    })
    if (!selected?.[0] || selected[0].scheme !== "file") return
    const cfg = await manifest(selected[0].fsPath)
    const mode = await vscode.window.showQuickPick(
      [
        {
          label: "Use a service you manage",
          description: "You start and stop the service yourself.",
          value: "external",
        },
        {
          label: "Start and stop the service with Raya",
          description: "Raya starts and stops this service when you use Memory.",
          value: "managed",
        },
      ],
      { title: "Memory service ownership" },
    )
    if (!mode) return
    let managed: Descriptor | undefined
    if (mode.value === "managed") {
      const files = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { "Managed launch descriptor": ["json"] },
        title: "Select the reviewed managed Memory launch",
      })
      if (!files?.[0] || files[0].scheme !== "file") return
      managed = await metadata(files[0].fsPath, descriptor)
      await selection(managed, cfg)
    }
    const accepted = await vscode.window.showWarningMessage(
      `Trust ${cfg.origin} for standalone search of ${cfg.root}? ${managed ? "Check, Search or Sync starts the service. Raya stops it when Memory is disconnected or Raya closes." : "You start and stop the service yourself."} Search results stay in this panel. This does not approve source indexing or enable capture.`,
      { modal: true },
      "Trust service",
    )
    if (accepted !== "Trust service") return
    const key = await vscode.window.showInputBox({
      password: true,
      ignoreFocusOut: true,
      prompt: "Local Memory service credential (stored only in VS Code Secret Storage)",
    })
    if (key === undefined) return
    await this.service.configure(() => this.settings.save(cfg, key, managed))
  }

  private async review() {
    const names = await vscode.window.showInputBox({
      prompt:
        "Complete source allowlist: relative Markdown paths separated by newlines or semicolons. Omitted sources are removed.",
      ignoreFocusOut: true,
    })
    if (names === undefined) return
    const selected = names
      .split(/[;\r\n]+/)
      .map((value) => value.trim())
      .filter(Boolean)
    if (!selected.length || selected.length > 128) throw new Error("Select 1–128 relative source files")
    const enabled = await vscode.window.showQuickPick(
      [
        { label: "Enable this reviewed source policy", value: true },
        { label: "Keep this source policy disabled", value: false },
      ],
      { title: "Memory source policy enablement" },
    )
    if (!enabled) return
    await this.control.review(selected, enabled.value, (value) => this.confirm(value, "Approve policy"))
  }

  private async catalog() {
    await this.control.stop()
    const selected = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "Memory control catalog": ["json"] },
      title: "Select the reviewed local Memory control release",
    })
    if (!selected?.[0] || selected[0].scheme !== "file") return
    const catalog = await metadata(selected[0].fsPath, parseCatalog)
    const cfg = await this.settings.load()
    if (!cfg) throw new Error("Search setup required")
    if (
      catalog.version !== cfg.setup.version ||
      Object.entries(cfg.setup.source_sha256).some(([name, hash]) => catalog.source_sha256[name] !== hash)
    )
      throw new Failure("identity_mismatch", "Control and search releases differ", 0)
    const accepted = await vscode.window.showWarningMessage(
      `Trust this separately reviewed local control release for ${cfg.setup.root}? Python: ${catalog.python}. Source: ${catalog.source}. Bridge: ${catalog.bridge}. This does not approve sources or start sync.`,
      { modal: true },
      "Trust control release",
    )
    if (accepted !== "Trust control release") return
    await this.service.configure(async () => {
      const current = await this.settings.load()
      if (!current || !this.settings.current(cfg.setup) || JSON.stringify(current.setup) !== JSON.stringify(cfg.setup))
        throw new Error("Memory setup changed during control review")
      await this.context.globalState.update(catalogKey, { root: cfg.setup.root, catalog })
      if (!this.settings.current(cfg.setup)) throw new Error("Memory setup changed during control publication")
    }, false)
  }

  private async confirm(value: Review, action: string) {
    const uri = vscode.Uri.from({ scheme: "raya-memory-review", path: "/" + crypto.randomUUID() + ".txt" })
    const provider = vscode.workspace.registerTextDocumentContentProvider("raya-memory-review", {
      provideTextDocumentContent: (requested) => (requested.toString() === uri.toString() ? value.text : ""),
    })
    try {
      const document = await vscode.workspace.openTextDocument(uri)
      await vscode.window.showTextDocument(document, { preview: false })
      const answer = await vscode.window.showWarningMessage(
        `${action === "Sync now" ? "Start local indexing for" : "Publish"} the complete policy shown in the read-only review? Enabled: ${value.enabled}. Policy SHA-256: ${value.digest}. Capture stays disabled.`,
        { modal: true },
        action,
      )
      return answer === action && !document.isClosed && document.getText() === value.text
    } finally {
      provider.dispose()
    }
  }
}
