import * as vscode from "vscode"
import { manifest, metadata } from "./manifest"
import { BrainSettings } from "./settings"
import { BrainService } from "./service"
import { Failure } from "./client"
import type { BrainRequest, BrainResponse, BrainProposalCommand, BrainProposal } from "../shared/second-brain"
import { isDeepStrictEqual } from "node:util"
import * as path from "node:path"
import { BrainControl, type Review } from "./control"
import { BrainClient } from "./client"
import { join } from "./join"
import { Control, parseCatalog } from "./control/index"
import { drain, register } from "./retirement"
import { descriptor, selection, type Descriptor } from "./managed/descriptor"
import { diagnostic } from "./diagnostic"
import { selection as dreamSelection } from "./dream-selection"
import { picked as dreamSources } from "./dream-sources"
import { targets as dreamTargets } from "./dream-sources"
import { MemoryFiles } from "@kilocode/kilo-memory/store"
import { snapshot as dreamSnapshot } from "./dream-view"

function recall(row: Record<string, unknown>): row is { action: "context"; query: string; budget: number } {
  return (
    Object.keys(row).sort().join("|") === "action|budget|query" &&
    typeof row.query === "string" &&
    typeof row.budget === "number" &&
    row.action === "context"
  )
}

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

  private async inspectDream() {
    if (!vscode.workspace.isTrusted) throw new Error("Trust the selected workspace before inspecting its memory")
    const folders = vscode.workspace.workspaceFolders
    if (!folders?.length) throw new Error("Open the Dream workspace to inspect its saved checkpoint")
    const folder =
      folders.length === 1
        ? folders[0]
        : await vscode.window.showWorkspaceFolderPick({ placeHolder: "Select the Dream project" })
    if (!folder || folder.uri.scheme !== "file") return
    const cfg = await this.settings.load()
    if (!cfg || cfg.setup.version !== 2) throw new Error("Select a reviewed SecondBrain configuration")
    const text = await dreamSnapshot(cfg.setup.root, folder.uri.fsPath, new AbortController().signal)
    if (
      !vscode.workspace.isTrusted ||
      !this.settings.current(cfg.setup) ||
      !vscode.workspace.getWorkspaceFolder(folder.uri)
    )
      throw new Error("Original Dream configuration changed during inspection")
    const uri = vscode.Uri.from({ scheme: "raya-memory-dream-checkpoint", path: "/" + crypto.randomUUID() + ".json" })
    const provider = vscode.workspace.registerTextDocumentContentProvider(uri.scheme, {
      provideTextDocumentContent: (selected) => (selected.toString() === uri.toString() ? text : ""),
    })
    try {
      const document = await vscode.workspace.openTextDocument(uri)
      await vscode.window.showTextDocument(document, { preview: true })
    } finally {
      provider.dispose()
    }
  }

  async pickDreamTargets(project: string, signal: AbortSignal) {
    signal.throwIfAborted()
    const cfg = await this.settings.load()
    if (!cfg || cfg.setup.version !== 2) throw new Error("Select a reviewed SecondBrain configuration")
    const root = cfg.setup.root
    const authorize = () => {
      signal.throwIfAborted()
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project))
      if (
        !vscode.workspace.isTrusted ||
        !folder ||
        path.resolve(folder.uri.fsPath) !== path.resolve(project) ||
        !this.settings.current(cfg.setup)
      )
        throw new Error("Original Dream target selection is no longer authorized")
    }
    authorize()
    const saved = await MemoryFiles.dream.list(root, project)
    const selected = []
    while (selected.length < 8) {
      authorize()
      const file = await vscode.window.showSaveDialog({
        title: "Select an existing or new SecondBrain note target (nothing is saved yet)",
        defaultUri: vscode.Uri.file(root),
        filters: { Markdown: ["md"] },
      })
      authorize()
      if (!file) return undefined
      if (file.scheme !== "file") throw new Error("Dream targets require local files")
      const name = path.relative(root, file.fsPath).replaceAll(path.sep, "/")
      const existing = saved.slots.find((item) => item.path.toLowerCase() === name.toLowerCase())
      const key = await vscode.window.showInputBox({
        title: "Stable note identity",
        prompt: "Reuse the same identity when moving a note. This preserves earlier review decisions.",
        value: existing?.key,
        validateInput: (value) =>
          /^[a-z0-9][a-z0-9_.-]{0,127}$/.test(value)
            ? undefined
            : "Use lowercase letters, digits, dots, dashes or underscores.",
      })
      authorize()
      if (!key) return undefined
      selected.push({ key, path: file.fsPath })
      const action = await vscode.window.showQuickPick(["Finish target selection", "Add another note"], {
        title: `${selected.length} of 8 note targets selected`,
      })
      authorize()
      if (!action) return undefined
      if (action === "Finish target selection") break
    }
    return dreamTargets(root, project, selected, authorize, signal)
  }

  async pickDreamSources(project: string, signal: AbortSignal) {
    signal.throwIfAborted()
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project))
    if (!vscode.workspace.isTrusted || !folder || path.resolve(folder.uri.fsPath) !== path.resolve(project))
      throw new Error("Select an exact trusted Dream workspace")
    const files = await vscode.window.showOpenDialog({
      title: "Select already approved summaries or notes for consolidation",
      defaultUri: folder.uri,
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      filters: { Markdown: ["md"] },
    })
    signal.throwIfAborted()
    if (!files?.length) return undefined
    const kind = await vscode.window.showQuickPick(
      [
        { label: "Approved summaries", value: "approved-summary" as const },
        { label: "Approved notes", value: "approved-note" as const },
      ],
      { title: "What approved inputs did you select?" },
    )
    signal.throwIfAborted()
    if (!kind) return undefined
    if (!vscode.workspace.isTrusted || !vscode.workspace.getWorkspaceFolder(folder.uri))
      throw new Error("Workspace trust changed during selection")
    return dreamSources(
      project,
      files.map((file) => {
        if (file.scheme !== "file") throw new Error("Dream sources require local files")
        return file.fsPath
      }),
      kind.value,
      signal,
    )
  }

  /** Native manual selection boundary; model/webview messages cannot mint this grant. */
  async selectDream(project: string, approved: Parameters<typeof dreamSelection>[0]["approved"], signal: AbortSignal) {
    return dreamSelection(
      {
        settings: this.settings,
        project,
        approved,
        trusted: (directory) => {
          if (!vscode.workspace.isTrusted) return false
          const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(directory))
          return !!folder && path.resolve(folder.uri.fsPath) === path.resolve(directory)
        },
        review: async (selected, current) => {
          current.throwIfAborted()
          const text = JSON.stringify(selected, null, 2)
          const uri = vscode.Uri.from({
            scheme: "raya-memory-dream-selection",
            path: "/" + crypto.randomUUID() + ".txt",
          })
          const provider = vscode.workspace.registerTextDocumentContentProvider("raya-memory-dream-selection", {
            provideTextDocumentContent: (requested) => (requested.toString() === uri.toString() ? text : ""),
          })
          try {
            const document = await vscode.workspace.openTextDocument(uri)
            await vscode.window.showTextDocument(document, { preview: false })
            const answer = await vscode.window.showWarningMessage(
              "Authorize one manual consolidation of the selected source and note revisions shown? This prepares pending proposals; capture remains off and publication requires separate review.",
              { modal: true },
              "Authorize selected inputs",
            )
            current.throwIfAborted()
            return answer === "Authorize selected inputs" && !document.isClosed && document.getText() === text
          } finally {
            provider.dispose()
          }
        },
      },
      signal,
    )
  }

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
    context.subscriptions.push(
      vscode.commands.registerCommand("raya.memory.inspectConfiguration", () =>
        diagnostic(this.settings, context.globalState),
      ),
      vscode.commands.registerCommand("raya.memory.inspectDream", () => this.inspectDream()),
    )
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
    if (message.action === "proposal") {
      await this.proposal(message, post)
      return true
    }
    if (message.action === "search" && typeof message.query === "string")
      await this.handle({ type: "secondBrain", action: "search", id: message.id, query: message.query }, post)
    if (message.action === "context" && typeof message.query === "string" && typeof message.budget === "number")
      await this.handle(
        { type: "secondBrain", action: "context", id: message.id, query: message.query, budget: message.budget },
        post,
      )
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
          action: message.action as Exclude<BrainRequest["action"], "search" | "context" | "cancel" | "proposal">,
          id: message.id,
        },
        post,
      )
    return true
  }

  /** Model requests can read approved context or prepare proposals, never authorize application. */
  async model(request: { project: string; command: unknown }, directory: string, signal: AbortSignal) {
    signal.throwIfAborted()
    const project = path.resolve(directory)
    if (project.toLowerCase() !== path.resolve(request.project).toLowerCase() || !vscode.workspace.isTrusted)
      throw new Error("Authenticated trusted project required")
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project))
    if (!folder || path.resolve(folder.uri.fsPath).toLowerCase() !== project.toLowerCase())
      throw new Error("Select an exact trusted workspace folder")
    if (!request.command || typeof request.command !== "object" || Array.isArray(request.command))
      throw new Error("Proposal command required")
    const row = request.command as Record<string, unknown>
    if (row.action === "context") {
      if (!recall(row)) throw new Error("Bounded context command required")
      const result = await this.service.context(row.query, row.budget, signal)
      signal.throwIfAborted()
      return {
        action: "context" as const,
        project,
        root: result.root,
        context: {
          ...result.context,
          sources: result.context.sources.map((source) => ({ ...source })),
          diagnostics: result.context.diagnostics.map((row) => ({ ...row })),
        },
      }
    }
    if ("project" in row || !["list", "read", "propose"].includes(String(row.action)))
      throw new Error("Model requests cannot edit, cancel or apply proposals")
    const command = { ...row, project } as BrainProposalCommand
    const result = await this.service.proposal(command, signal)
    signal.throwIfAborted()
    const proposals = ("proposals" in result ? result.proposals : [result]).map((value) => ({
      ...value,
      sources: value.sources.map((source) => ({ ...source })),
      changes: value.changes.map((change) => ({ ...change })),
    }))
    if (row.action !== "list" && (proposals.length !== 1 || proposals[0].id !== row.id))
      throw new Error("Original proposal is unavailable")
    if (row.action === "propose" && proposals[0]?.status !== "pending")
      throw new Error("Original proposal creation is unconfirmed")
    return { action: row.action as "list" | "read" | "propose", project, proposals }
  }

  private async proposal(message: Record<string, unknown>, post: (value: BrainResponse) => void) {
    if (typeof message.id !== "string") return
    if (!/^[a-z0-9-]{1,80}$/i.test(message.id)) return
    try {
      const command = message.command
      if (!command || typeof command !== "object" || Array.isArray(command))
        throw new Error("Proposal command required")
      const row = command as Record<string, unknown>
      if (typeof row.project !== "string" || !path.isAbsolute(row.project) || !vscode.workspace.isTrusted)
        throw new Error("Select a trusted project")
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(row.project))
      if (!folder || path.resolve(folder.uri.fsPath).toLowerCase() !== path.resolve(row.project).toLowerCase())
        throw new Error("Proposal project must match an open trusted workspace folder")
      if (!["list", "read", "propose", "edit", "cancel", "apply"].includes(String(row.action)))
        throw new Error("Unknown proposal action")
      const body = command as BrainProposalCommand
      const cfg = await this.settings.load()
      if (!cfg || cfg.setup.version !== 2) throw new Error("Reviewed Memory setup required")
      if (body.action === "apply") {
        const review = await this.approve(body, folder)
        if (!review.accepted) {
          post({
            type: "secondBrainState",
            id: message.id,
            state: { ...(await this.service.status()), proposals: review.selected },
          })
          return
        }
      }
      const proposals = await this.service.proposal(body)
      if (["read", "cancel", "apply"].includes(body.action) && !("proposals" in proposals)) {
        if (!this.settings.current(cfg.setup)) throw new Error("Memory setup changed before Dream reconciliation")
        await MemoryFiles.dreamProposal.reconcile(cfg.setup.root, body.project, proposals, AbortSignal.timeout(15000))
      }
      post({ type: "secondBrainState", id: message.id, state: { ...(await this.service.status()), proposals } })
    } catch {
      post({
        type: "secondBrainState",
        id: message.id,
        state: { configured: true, status: "unavailable", code: "proposal_review_required", results: [] },
      })
    }
  }

  private async approve(
    body: Extract<BrainProposalCommand, { action: "cancel" | "apply" }>,
    folder: vscode.WorkspaceFolder,
  ) {
    const cfg = await this.settings.load()
    if (!cfg || cfg.setup.version !== 2) throw new Error("Reviewed Memory setup required")
    const selected = await this.service.proposal({ action: "read", project: body.project, id: body.id })
    if (!("digest" in selected) || selected.digest !== body.digest || selected.status !== "pending")
      throw new Error("Proposal changed before review")
    const text = JSON.stringify(selected, null, 2)
    const uri = vscode.Uri.from({ scheme: "raya-memory-proposal", path: "/" + crypto.randomUUID() + ".txt" })
    const provider = vscode.workspace.registerTextDocumentContentProvider("raya-memory-proposal", {
      provideTextDocumentContent: (requested) => (requested.toString() === uri.toString() ? text : ""),
    })
    try {
      const document = await vscode.workspace.openTextDocument(uri)
      await vscode.window.showTextDocument(document, { preview: false })
      const answer = await vscode.window.showWarningMessage(
        `Apply the exact Second Brain changes shown for ${body.project}? Review SHA-256: ${body.digest}. Capture stays disabled.`,
        { modal: true },
        "Apply reviewed changes",
      )
      if (answer !== "Apply reviewed changes" || document.isClosed || document.getText() !== text)
        return { accepted: false, selected }
      if (!vscode.workspace.isTrusted || !vscode.workspace.getWorkspaceFolder(folder.uri))
        throw new Error("Workspace trust changed during review")
      const current = await this.service.proposal({ action: "read", project: body.project, id: body.id })
      if (!isDeepStrictEqual(current, selected)) throw new Error("Proposal changed during review")
      if (!this.settings.current(cfg.setup)) throw new Error("Memory setup changed during review")
    } finally {
      provider.dispose()
    }
    return { accepted: true, selected }
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
      if (message.action === "search" || message.action === "context") {
        await this.query(message, send)
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

  private async query(
    message: Extract<BrainRequest, { action: "search" | "context" }>,
    post: (state: BrainResponse["state"]) => void,
  ) {
    if (typeof message.query !== "string" || !message.query.trim() || message.query.length > 8000)
      throw new Error("Invalid query")
    const owner = {}
    this.current = { id: message.id, owner }
    if (
      message.action === "context" &&
      (!Number.isSafeInteger(message.budget) || message.budget < 1 || message.budget > 12000)
    )
      throw new Error("Invalid context budget")
    await this.service.run(
      message.query,
      post,
      owner,
      message.action === "context" ? { budget: message.budget, parent: new AbortController().signal } : undefined,
    )
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
