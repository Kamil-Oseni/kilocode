import * as vscode from "vscode"
import { pick as dreamPick } from "./dream-pick"
import { manifest, metadata } from "./manifest"
import { BrainSettings } from "./settings"
import { BrainService } from "./service"
import { Failure } from "./client"
import type { BrainRequest, BrainResponse, BrainProposalCommand, BrainProposalResult } from "../shared/second-brain"
import { isDeepStrictEqual } from "node:util"
import * as path from "node:path"
import { BrainControl, type Review } from "./control"
import { BrainClient } from "./client"
import { join } from "./join"
import { Control, parseCatalog } from "./control/index"
import { drain, register } from "./retirement"
import { descriptor, selection, type Descriptor } from "./managed/descriptor"
import { diagnostic } from "./diagnostic"
import { review as refusedCapture } from "./capture-refusal"
import { selection as dreamSelection } from "./dream-selection"
import { picked as dreamSources } from "./dream-sources"
import { targets as dreamTargets } from "./dream-sources"
import { MemoryFiles } from "@kilocode/kilo-memory/store"
import { snapshot as dreamSnapshot } from "./dream-view"
import { explanation } from "./dream-review"
import { DreamTransport } from "./dream-transport"
import { entry as dreamEntry } from "./dream-entry"
import { DreamActivity } from "./dream-activity"
import { Effect, Schema } from "effect"
import { choices } from "./note-choices"
import { unchanged } from "./review"
import { ClosedRequired } from "./closed-recovery"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"

import { CaptureIntake, type CapturePublication } from "./capture-intake"
import { failure } from "./capture-failure"
import { personal } from "./scope"
import { admission } from "./index-admission"
import { currentPolicy, freshHistory, disposeHistory } from "./capture-revisions"
import { MediaCoordinator } from "./media/coordinator"
import { register as mediaCommands } from "./media/native"
import { inspect as preparation, pinned, type PreparedSetup } from "./prepared-setup"
import { SetupFlow } from "./setup-flow"
import { hydrate } from "./setup-health"
import type { CaptureReceipt } from "../shared/second-brain"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { ManagementFlow, type ManagementAuthority } from "./management-flow"
import { review as reviewManagement } from "./management-native"
import { Manage } from "../../../opencode/src/kilocode/second-brain/management-protocol"

type IndexScope = {
  signal: AbortSignal
  check: () => void
  stage: (message: string) => void
  wait: <T>(body: () => PromiseLike<T>) => Promise<T>
}

type CaptureControl = { capture(body: CapturePublication, authorize: () => void): Promise<unknown> }
function capturing(value: object): value is object & CaptureControl {
  return "capture" in value && typeof value.capture === "function"
}

function captureTurn(request: { sessionID?: string }, row: Record<string, unknown>, project: string) {
  if (
    typeof request.sessionID !== "string" ||
    !request.sessionID ||
    request.sessionID.length > 256 ||
    typeof row.messageID !== "string" ||
    !row.messageID ||
    row.messageID.length > 256 ||
    typeof row.source_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.source_sha256)
  )
    throw new Error("Exact original completed capture turn required")
  return { project, sessionID: request.sessionID, messageID: row.messageID, source_sha256: row.source_sha256 }
}

function captureReceipt(receipt: unknown, id: string) {
  if (
    !receipt ||
    typeof receipt !== "object" ||
    !("id" in receipt) ||
    receipt.id !== id ||
    !("input_sha256" in receipt) ||
    typeof receipt.input_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt.input_sha256)
  )
    throw new Error("Original indexed capture receipt differs")
  return receipt.input_sha256
}

function trusted(project: string) {
  if (!vscode.workspace.isTrusted) throw new Error("Authenticated trusted project required")
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project))
  if (!folder || path.resolve(folder.uri.fsPath).toLowerCase() !== project.toLowerCase())
    throw new Error("Select an exact trusted workspace folder")
}

function recall(row: Record<string, unknown>): row is { action: "context"; query: string; budget: number } {
  return (
    Object.keys(row).sort().join("|") === "action|budget|query" &&
    typeof row.query === "string" &&
    typeof row.budget === "number" &&
    row.action === "context"
  )
}

function multimedia(row: Record<string, unknown>): row is { action: "mediaContext"; query: string; top: number } {
  return (
    Object.keys(row).sort().join("|") === "action|query|top" &&
    row.action === "mediaContext" &&
    typeof row.query === "string" &&
    !!row.query.trim() &&
    Buffer.byteLength(row.query, "utf8") <= 2048 &&
    typeof row.top === "number" &&
    Number.isSafeInteger(row.top) &&
    row.top >= 1 &&
    row.top <= 10
  )
}

const services = new WeakMap<
  vscode.ExtensionContext,
  {
    settings: BrainSettings
    service: BrainService
    control: BrainControl
    intake: CaptureIntake
    media: MediaCoordinator
  }
>()
const catalogKey = "raya.secondBrain.control.catalog"

export function drainBrain() {
  return drain(true)
}

function decode(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Memory command required")
  return input as Record<string, unknown>
}

function setupModel(input: unknown) {
  if (input === undefined) return undefined
  const row = decode(input)
  if (
    Object.keys(row).sort().join() !== "modelID,providerID" ||
    typeof row.providerID !== "string" ||
    typeof row.modelID !== "string" ||
    !row.providerID ||
    !row.modelID ||
    row.providerID.length > 255 ||
    row.modelID.length > 255
  )
    throw new Error("Original conversation model required")
  return { providerID: row.providerID, modelID: row.modelID }
}

function setupCommand(row: Record<string, unknown>) {
  const fields = Object.keys(row).sort().join()
  if (row.stage === "inspect" && ["action,stage", "action,model,stage"].includes(fields))
    return { stage: "inspect" as const, model: setupModel(row.model) }
  if (typeof row.attempt !== "string" || !/^[0-9a-f-]{36}$/.test(row.attempt))
    throw new Error("Original Memory setup attempt required")
  if (row.stage === "cancel" && fields === "action,attempt,stage")
    return { stage: "cancel" as const, attempt: row.attempt }
  if (
    row.stage === "continue" &&
    fields === "action,attempt,choice,stage" &&
    typeof row.choice === "string" &&
    row.choice.length <= 64
  )
    return { stage: "continue" as const, attempt: row.attempt, choice: row.choice }
  throw new Error("Exact conversation Memory setup command required")
}

export class BrainHost {
  private readonly settings: BrainSettings
  private readonly service: BrainService
  private readonly control: BrainControl
  private readonly intake: CaptureIntake
  private readonly media: MediaCoordinator
  private readonly observer: ReturnType<CaptureIntake["observe"]>
  private view: { id: string; state: BrainResponse["state"]; post: (value: BrainResponse) => void } | undefined
  private current: { id: string; owner: object } | undefined
  private dream?: Promise<void>
  private indexing?: { controller: AbortController; job: Promise<void> }
  private closing = false
  private controller?: AbortController
  private debt?: unknown
  private readonly activity = new DreamActivity()
  private onboarding?: SetupFlow
  private management?: ManagementFlow

  observeCapture(listener: (receipt: CaptureReceipt | undefined) => void): vscode.Disposable {
    const publish = () => {
      if (this.closing || !vscode.workspace.isTrusted) {
        listener(undefined)
        return
      }
      try {
        listener(this.intake.lastSaved(this.service.captureSnapshot()))
      } catch {
        console.warn("[Raya] Confirmed Memory saved-entry metadata is unavailable")
        listener(undefined)
      }
    }
    const subscription = this.intake.observe(publish)
    publish()
    return subscription
  }

  dreamActivity() {
    return this.activity.snapshot()
  }

  async cancelDream(target: unknown) {
    const work = this.dream
    if (!work) throw new Error("Original consolidation is not active")
    return this.activity.join(target, work)
  }

  startDream(connection: KiloConnectionService) {
    if (this.closing) return Promise.reject(new Error("Memory consolidation intake is retired"))
    if (this.debt)
      return Promise.reject(new Error("Original consolidation cleanup is unconfirmed; inspect its checkpoint"))
    if (this.dream) return this.dream
    const controller = new AbortController()
    this.controller = controller
    const identity = { id: crypto.randomUUID(), owner: crypto.randomUUID() }
    const work = (async () => {
      this.activity.begin({ ...identity, project: "", model: "" }, controller)
      await this.consolidate(connection, controller, identity)
    })().finally(() => {
      controller.abort()
      this.controller = undefined
      this.activity.finish(this.debt !== undefined)
      this.dream = undefined
    })
    this.dream = work
    return work
  }

  private async stopDream() {
    this.closing = true
    this.controller?.abort()
    if (this.dream) await Promise.allSettled([this.dream])
    if (this.debt) throw this.debt
  }

  private async consolidate(
    connection: KiloConnectionService,
    controller: AbortController,
    identity: { id: string; owner: string },
  ) {
    const signal = controller.signal
    signal.throwIfAborted()
    if (!vscode.workspace.isTrusted) throw new Error("Trust the selected consolidation workspace")
    const folders = vscode.workspace.workspaceFolders
    if (!folders?.length) throw new Error("Open the project whose approved notes you want to consolidate")
    const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick()
    signal.throwIfAborted()
    if (!folder || folder.uri.scheme !== "file") return
    const project = folder.uri.fsPath
    this.activity.select({ ...identity, project, model: "" })
    const client = await connection.getClientAsync(project)
    signal.throwIfAborted()
    const catalog = await client.provider.list({ directory: project }, { signal })
    signal.throwIfAborted()
    if (catalog.error || !catalog.data) throw new Error("Original backend model catalog is unavailable")
    if (this.closing) throw new Error("Memory consolidation intake is retired")
    const data = catalog.data
    const selected = await dreamPick(signal, (token) =>
      vscode.window.showQuickPick(
        data.all
          .filter((provider) => data.connected.includes(provider.id))
          .flatMap((provider) =>
            Object.values(provider.models).map((model) => ({
              label: model.name,
              description: provider.name,
              model: `${provider.id}/${model.id}`,
            })),
          ),
        { title: "Choose the consolidation model", matchOnDescription: true },
        token,
      ),
    )
    signal.throwIfAborted()
    if (!selected) return
    this.activity.select({ ...identity, project, model: selected.model })
    if (this.closing) throw new Error("Memory consolidation intake is retired")
    if (connection.getClient() !== client) throw new Error("Original Dream backend changed; review again")
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Consolidate approved memories",
        cancellable: true,
      },
      async (progress, cancellation) => {
        if (this.closing) controller.abort()
        const off = cancellation.onCancellationRequested(() => controller.abort())
        if (cancellation.isCancellationRequested) controller.abort()
        let grant: Awaited<ReturnType<BrainHost["selectDream"]>> | undefined
        let model: DreamTransport | undefined
        const errors: unknown[] = []
        try {
          progress.report({ message: "Select approved sources and note targets" })
          const sources = await this.pickDreamSources(project, signal)
          if (!sources) return
          const targets = await this.pickDreamTargets(project, signal)
          if (!targets) return
          grant = await this.selectDream(project, { sources, ...targets }, signal)
          if (connection.getClient() !== client) throw new Error("Original Dream backend changed; review again")
          model = new DreamTransport(connection, { ...identity, project, model: selected.model })
          const approved = grant.approved
          const authority = grant
          const transport = model
          progress.report({ message: "Preparing proposals; note publication requires separate review" })
          const result = await MemoryFiles.dreamManual.start(
            grant.root,
            project,
            {
              ...identity,
              model: selected.model,
              approved,
              budget: { input: 12000, output: 4000 },
              timeout: 300000,
            },
            {
              authorize: authority.authorize,
              model: {
                ...transport.port,
                retire: () => {
                  this.activity.settling()
                  return transport.close()
                },
              },
              execute: Effect.runPromise,
              observe: (run) => {
                this.activity.observe(run)
                const phases = {
                  generation: "Preparing or generating proposals",
                  validation: "Checking sources and changes",
                  submission: "Saving pending proposals",
                  "review-pending": "Proposals ready for review",
                  reconciliation: "Original run needs inspection",
                  completed: "Consolidation completed",
                  cancelled: "Consolidation cancelled",
                  failed: "Consolidation failed",
                }
                progress.report({ message: `${phases[run.phase]} · ${run.model} · changes require separate review` })
              },
              propose: (id, candidate, current) =>
                MemoryFiles.dreamProposal.submit(
                  project,
                  id,
                  candidate,
                  (command, current) =>
                    this.service.proposal(command, current, async (root, active) => {
                      await authority.authorize(root, project, approved, active)
                    }),
                  current,
                ),
            },
            signal,
          )
          progress.report({
            message:
              result.phase === "review-pending"
                ? "Pending proposals are ready for review in Memory"
                : "No supported changes need review",
          })
        } catch (err) {
          errors.push(err)
        } finally {
          this.activity.settling()
          off.dispose()
          controller.abort()
          grant?.close()
          await model?.close().catch((err: unknown) => {
            this.debt = err
            if (!errors.includes(err)) errors.push(err)
          })
        }
        if (errors.length && signal.aborted && !this.debt && grant) {
          const saved = await MemoryFiles.dream.list(grant.root, project).catch((err: unknown) => {
            errors.push(err)
            return undefined
          })
          if (
            saved?.runs.some(
              (run) => run.id === identity.id && run.owner === identity.owner && run.phase === "cancelled",
            )
          )
            return
        }
        if (errors.length === 1) throw errors[0]
        if (errors.length) throw new AggregateError(errors, "Original consolidation failures remain unconfirmed")
      },
    )
  }

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
      const key = await dreamPick(signal, (token) =>
        vscode.window.showInputBox(
          {
            title: "Stable note identity",
            prompt: "Reuse the same identity when moving a note. This preserves earlier review decisions.",
            value: existing?.key,
            validateInput: (value) =>
              /^[a-z0-9][a-z0-9_.-]{0,127}$/.test(value)
                ? undefined
                : "Use lowercase letters, digits, dots, dashes or underscores.",
          },
          token,
        ),
      )
      authorize()
      if (!key) return undefined
      selected.push({ key, path: file.fsPath })
      const action = await dreamPick(signal, (token) =>
        vscode.window.showQuickPick(
          ["Finish target selection", "Add another note"],
          {
            title: `${selected.length} of 8 note targets selected`,
          },
          token,
        ),
      )
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
    const kind = await dreamPick(signal, (token) =>
      vscode.window.showQuickPick(
        [
          { label: "Approved summaries", value: "approved-summary" as const },
          { label: "Approved notes", value: "approved-note" as const },
        ],
        { title: "What approved inputs did you select?" },
        token,
      ),
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
              "Authorize one manual consolidation of the selected source and note revisions shown? This prepares pending proposals; publication requires separate review.",
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
    register(() => this.stopDream())
    context.subscriptions.push({
      dispose: () => {
        void this.stopDream().catch(() => console.warn("[Raya] Consolidation cleanup is unconfirmed"))
      },
    })
    const existing = services.get(context)
    this.settings = existing?.settings ?? new BrainSettings(context.globalState, context.secrets, context.extensionPath)
    this.service = existing?.service ?? new BrainService(this.settings, context.extensionPath)
    this.intake = existing?.intake ?? new CaptureIntake(context.globalState)
    this.media =
      existing?.media ??
      new MediaCoordinator({
        extension: context.extensionPath,
        storage: context.globalStorageUri.fsPath,
        store: context.globalState,
        trusted,
      })
    this.control =
      existing?.control ??
      new BrainControl(this.service, this.settings, async (setup, caller = () => {}) => {
        caller()
        const saved = context.globalState.get<{ root: string; catalog: unknown }>(catalogKey)
        if (!saved || saved.root !== setup.root)
          throw new Failure("control_setup_required", "Select a reviewed Memory control catalog", 0)
        const catalog = parseCatalog(saved.catalog)
        if (
          catalog.version !== setup.version ||
          Object.entries(setup.source_sha256).some(([name, hash]) => catalog.source_sha256[name] !== hash)
        )
          throw new Failure("identity_mismatch", "Control and search releases differ", 0)
        return Control.open(setup.root, catalog, context.extensionPath, caller)
      })
    this.observer = this.intake.observe(() => {
      const view = this.view
      if (!view || this.closing) return
      view.post({
        type: "secondBrainState",
        id: view.id,
        live: true,
        state: {
          ...view.state,
          capture: {
            ...this.intake.snapshot(this.service.captureSnapshot()),
            enabled: this.intake.enabled(),
            lastSaved: this.intake.lastSaved(this.service.captureSnapshot()),
          },
          control: this.control.snapshot(),
        },
      })
    })
    context.subscriptions.push(this.observer)
    if (existing) return
    services.set(context, {
      settings: this.settings,
      service: this.service,
      control: this.control,
      intake: this.intake,
      media: this.media,
    })
    register(() => this.media.retire())
    mediaCommands(context, this.media, this.settings, trusted)
    context.subscriptions.push(
      vscode.commands.registerCommand("raya.memory.registerPreparedSetup", async (input: unknown) => {
        if (!vscode.workspace.isTrusted || this.closing) throw new Error("Trusted Memory preparation required")
        const cfg = await preparation(input)
        const folder = this.context.globalStorageUri.fsPath
        await mkdir(folder, { recursive: true })
        const file = path.join(folder, "memory-prepared-" + randomUUID() + ".json")
        await writeFile(file, JSON.stringify(cfg.bundle), { flag: "wx", mode: 0o600 })
        await rename(file, path.join(folder, "memory-prepared.json"))
        return { root: cfg.setup.root, prepared: true, authorized: false }
      }),
      vscode.commands.registerCommand("raya.memory.inspectConfiguration", () =>
        diagnostic(this.settings, context.globalState),
      ),
      vscode.commands.registerCommand("raya.memory.reconcileOperation", () => this.service.reconcile()),
      vscode.commands.registerCommand("raya.memory.repairFailedSearch", () => this.repair()),
      vscode.commands.registerCommand("kilo-code.new.memory.recoverInterruptedRead", (...args: unknown[]) => {
        if (args.length) throw new Error("Native Memory read recovery accepts no command arguments")
        return this.repair()
      }),
      vscode.commands.registerCommand("kilo-code.new.memory.upgradeRuntime", (...args: unknown[]) => {
        if (args.length || !vscode.workspace.isTrusted) throw new Error("Trusted native Memory update required")
        return this.service.upgradeRuntime()
      }),
      vscode.commands.registerCommand("raya.memory.archiveFailedSetup", () => this.archive()),
      vscode.commands.registerCommand("raya.memory.resumeClosedPair", () => this.resume()),
      vscode.commands.registerCommand("kilo-code.new.memory.recoverClosedPair", async (...args: unknown[]) => {
        try {
          if (args.length || !vscode.workspace.isTrusted) throw new Error("Trusted native Memory recovery required")
          return await this.resume()
        } catch (err) {
          const message =
            err instanceof Error && err.message === "Packaged helper fingerprint refused"
              ? "Memory recovery could not verify its packaged helper. Install the updated Raya package, then retry recovery."
              : "Memory recovery could not finish. Open Memory to review its status before trying again."
          void vscode.window.showErrorMessage(message)
          throw err
        }
      }),
      vscode.commands.registerCommand("raya.memory.inspectDream", () => this.inspectDream()),
      vscode.commands.registerCommand("kilo-code.new.memory.activateReviewedCapture", (...args: unknown[]) => {
        if (args.length) throw new Error("Native capture activation accepts no command arguments")
        return this.activateCapture()
      }),
      vscode.commands.registerCommand("kilo-code.new.memory.recoverCommittedCapture", (...args: unknown[]) => {
        if (args.length) throw new Error("Native capture recovery accepts no command arguments")
        return this.recoverCapture()
      }),
      vscode.commands.registerCommand("kilo-code.new.memory.indexRecoveredCapture", (...args: unknown[]) => {
        if (args.length) throw new Error("Native recovered-save indexing accepts no command arguments")
        return this.indexCapture()
      }),
      vscode.commands.registerCommand("kilo-code.new.memory.reconcileRefusedCapture", (...args: unknown[]) => {
        if (args.length) throw new Error("Native capture refusal review accepts no command arguments")
        return this.reconcileRefusal()
      }),
      vscode.commands.registerCommand("kilo-code.new.memory.abandonReservedCapture", (...args: unknown[]) => {
        if (args.length) throw new Error("Native reservation review accepts no command arguments")
        return this.abandonReservation()
      }),
    )
    const close = (terminating = false) => {
      this.management?.close()
      if (terminating) this.settings.retire()
      return join([this.retireIndex(), this.control.dispose(), this.service.dispose(), Control.drain()])
    }
    register(close)
    context.subscriptions.push({
      dispose: () => {
        void close().catch(() => console.warn("[Raya] Memory coordinator cleanup failed"))
      },
    })
  }

  /** Retires this panel subscription while other panels retain the shared service. */
  detach() {
    this.view = undefined
    this.observer.dispose()
  }

  async accept(message: Record<string, unknown>, post: (value: BrainResponse) => void) {
    if (message.type !== "secondBrain") return false
    if (typeof message.id !== "string") return true
    if (await dreamEntry(message, (command, target) => vscode.commands.executeCommand(command, target), post))
      return true
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
      [
        "state",
        "setup",
        "check",
        "reconcile",
        "repair",
        "archive",
        "resume",
        "disconnect",
        "controlSetup",
        "review",
        "sync",
        "disable",
      ].includes(String(message.action))
    )
      await this.handle(
        {
          type: "secondBrain",
          action: message.action as Exclude<
            BrainRequest["action"],
            | "search"
            | "context"
            | "cancel"
            | "proposal"
            | "dreamStart"
            | "dreamInspect"
            | "dreamActivity"
            | "dreamCancel"
          >,
          id: message.id,
        },
        post,
      )
    return true
  }

  /** Model requests can read approved context or prepare proposals, never authorize application. */
  async model(
    request: { project: string; sessionID?: string; command: unknown },
    directory: string,
    signal: AbortSignal,
    authority?: ManagementAuthority,
  ) {
    signal.throwIfAborted()
    const project = path.resolve(directory)
    if (project.toLowerCase() !== path.resolve(request.project).toLowerCase())
      throw new Error("Authenticated trusted project required")
    const row = decode(request.command)
    const guard = [
      "setup",
      "manage",
      "captureState",
      "status",
      "context",
      "capturePolicy",
      "capture",
      "captureFailed",
    ].includes(String(row.action))
      ? personal(project, () => ({
          trusted: vscode.workspace.isTrusted,
          folders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
        }))
      : () => trusted(project)
    guard()
    if (row.action === "manage") return this.manage(row, project, request.sessionID, authority, signal, guard)
    if (row.action === "setup") return this.conversationSetup(row, project, request.sessionID, signal, guard)
    if (row.action === "captureState") return this.captureState(row, project, signal, guard)
    if (["capturePolicy", "capture", "captureFailed"].includes(String(row.action)))
      return this.capture(request, project, signal, guard)
    if (row.action === "status") {
      const result = await this.inspect(row, project, signal)
      guard()
      return result
    }
    if (row.action === "mediaContext") return this.multimedia(row, project, signal, guard)
    if (row.action === "context") {
      if (!recall(row)) throw new Error("Bounded context command required")
      const result = await this.service.context(row.query, row.budget, signal)
      signal.throwIfAborted()
      guard()
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

  private async manage(
    row: Record<string, unknown>,
    project: string,
    session: string | undefined,
    authority: ManagementAuthority | undefined,
    signal: AbortSignal,
    guard: () => void,
  ) {
    if (!authority || session !== Schema.decodeUnknownSync(Manage)(row).source.sessionID)
      throw new Error("Original personal Memory conversation authority required")
    this.management ??= new ManagementFlow({
      bind: async (current, check) => {
        await hydrate(this.service, this.control, await this.service.status(), current, check)
        const binding = await this.service.captureSelection(current)
        const policy = this.control.snapshot()
        if (
          binding.index !== "synced" ||
          policy.status !== "synced" ||
          !policy.digest ||
          binding.digest !== policy.digest
        )
          throw new Error("Current reviewed personal Memory sources and index required")
        return { selection: binding, policy: policy.digest }
      },
      current: (binding) => !this.closing && this.service.captureCurrent(binding.selection),
      execute: (body, current, check) => this.service.management(body, current, check),
      review: reviewManagement,
      publish: (proposal, binding, _signal, authorize) => this.control.manage(proposal, binding.policy, authorize),
    })
    return this.management.run(
      Schema.decodeUnknownSync(Manage)(row, { onExcessProperty: "error" }),
      project,
      authority,
      signal,
      guard,
    )
  }

  private async multimedia(row: Record<string, unknown>, project: string, signal: AbortSignal, guard: () => void) {
    if (!multimedia(row)) throw new Error("Exact bounded media context command required")
    const result = await this.media.context(project, row.query, row.top, signal)
    signal.throwIfAborted()
    guard()
    return result
  }

  /** Native setup only: original human authorization must accompany saved capture choices. */
  private async activateCapture() {
    if (this.closing || !vscode.workspace.isTrusted) throw new Error("Trusted capture setup required")
    const files = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFolders: false,
      filters: { "Reviewed capture choices": ["json"] },
      title: "Activate reviewed automatic Memory saving",
    })
    if (!files?.[0] || files[0].scheme !== "file") return
    const cfg = await metadata(files[0].fsPath, (value, digest) => this.intake.reviewed(value, digest))
    await this.saveCapture(cfg, new AbortController().signal)
    await vscode.window.showInformationMessage(
      cfg.enabled ? `Automatic Memory saving activated with ${cfg.model}.` : "Automatic Memory saving paused.",
    )
  }

  async saveCapture(value: unknown, signal: AbortSignal, caller: () => void = () => {}) {
    caller()
    if (this.closing || !vscode.workspace.isTrusted) throw new Error("Trusted capture setup required")
    const binding = await this.service.captureSelection(signal)
    const check = () => {
      caller()
      signal.throwIfAborted()
      if (this.closing || !vscode.workspace.isTrusted || !this.service.captureCurrent(binding))
        throw new Error("Original capture setup changed during consent publication")
    }
    await this.service.configure(() => this.intake.save(value, binding, check), false)
    check()
    if (!this.service.captureCurrent(binding) || !this.intake.saved(binding))
      throw new Error("Saved capture choices do not match the current reviewed Memory release")
  }

  private async capture(
    request: { project: string; sessionID?: string; command: unknown },
    project: string,
    signal: AbortSignal,
    guard: () => void,
  ) {
    const row = request.command as Record<string, unknown>
    const turn = captureTurn(request, row, project)
    const result = { project, sessionID: turn.sessionID, messageID: turn.messageID, source_sha256: turn.source_sha256 }
    if (row.action === "captureFailed") {
      const audit = await this.intake.fail(turn, row, (binding) => {
        signal.throwIfAborted()
        guard()
        if (this.closing || !vscode.workspace.isTrusted || !this.service.captureCurrent(binding))
          throw new Error("Original pre-transport extraction owner changed")
      })
      void vscode.window.showWarningMessage(
        `Memory did not save this reply (${audit.reason}). The failed extraction is retained and will not be retried.`,
      )
      return {
        action: "captureFailed" as const,
        ...result,
        id: audit.original.id,
        reason: audit.reason,
        status: "skipped" as const,
        requestSettlement: false as const,
        indexConfirmed: false as const,
        replay: false as const,
      }
    }
    if (row.action === "capturePolicy") {
      if (Object.keys(row).sort().join() !== "action,messageID,source_sha256")
        throw new Error("Exact capture policy command required")
      if (!this.intake.enabled()) return { action: "capturePolicy" as const, ...result, enabled: false }
    }
    const binding = await this.service.captureSelection(signal)
    const cfg = this.intake.selected(binding)
    const check = () => {
      signal.throwIfAborted()
      guard()
      if (
        this.closing ||
        !vscode.workspace.isTrusted ||
        !this.service.captureCurrent(binding) ||
        !isDeepStrictEqual(this.intake.selected(binding), cfg)
      )
        throw new Error("Original capture configuration, workspace or generation changed")
    }
    check()
    if (row.action === "capturePolicy") {
      const grant = await this.intake.grant(turn, binding, check)
      return { action: "capturePolicy" as const, ...result, enabled: !!grant, ...(grant ? { grant } : {}) }
    }
    try {
      const body = this.intake.consume(turn, this.intake.parse(row), binding, check)
      if (!body.entries.length) {
        await this.intake.finish(turn, "skipped")
        return { action: "capture" as const, ...result, status: "skipped" as const }
      }
      if (!capturing(this.control)) throw new Error("Select the reviewed capture-capable control release")
      await this.intake.begin(turn)
      const receipt = await this.control.capture(body, check)
      check()
      const hash = captureReceipt(receipt, body.id)
      await this.intake.finish(turn, "published", hash)
      return { action: "capture" as const, ...result, status: "published" as const, receipt: hash }
    } catch (err) {
      const phase =
        err instanceof Error && "code" in err && err.code === "capture_source_capacity" ? "capacity" : "uncertain"
      await this.intake.finish(turn, phase, undefined, failure(err)).catch((retained: unknown) => {
        throw new AggregateError([err, retained], "Original capture and outcome retention failed")
      })
      throw err
    } finally {
      this.intake.end(turn)
    }
  }

  private async inspect(row: Record<string, unknown>, project: string, signal: AbortSignal) {
    if (Object.keys(row).join() !== "action") throw new Error("Exact read-only Memory status command required")
    const state = await this.service.status()
    signal.throwIfAborted()
    if (state.status === "unavailable")
      throw new Error("Memory setup state is uncertain; wait for the original operation to settle")
    const capture = this.intake.snapshot(this.service.captureSnapshot())
    return {
      action: "status" as const,
      project,
      configured: state.configured,
      root: state.root,
      index: state.configured ? this.control.snapshot().status : ("unchecked" as const),
      capture: state.configured ? capture.status : ("unavailable" as const),
      ...(state.configured && capture.reason ? { capture_reason: capture.reason } : {}),
      preparation: "unavailable" as const,
    }
  }

  private async prepared() {
    const file = path.join(this.context.globalStorageUri.fsPath, "memory-prepared.json")
    return metadata(file, (value) => preparation(value)).catch((err: unknown) => {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined
      throw err
    })
  }

  private async captureState(row: Record<string, unknown>, project: string, signal: AbortSignal, guard: () => void) {
    if (Object.keys(row).sort().join() !== "action,mode" || !["pause", "resume"].includes(String(row.mode)))
      throw new Error("Exact Memory saving preference required")
    const check = () => {
      signal.throwIfAborted()
      guard()
      if (this.closing) throw new Error("Original Memory host closed")
    }
    check()
    if (row.mode === "pause") {
      const changed = await this.intake.pause(check)
      check()
      return {
        action: "captureState" as const,
        project,
        configured: this.settings.version() !== undefined,
        capture: this.intake.snapshot(this.service.captureSnapshot()).status,
        enabled: this.intake.enabled(),
        changed,
        detail:
          "Future automatic saving is paused. Any earlier save keeps its original status and will not be replayed.",
      }
    }
    const binding = await this.service.captureSelection(AbortSignal.any([signal, AbortSignal.timeout(35000)]))
    check()
    const cfg = this.intake.saved(binding)
    const state = this.intake.snapshot(binding)
    if (!cfg || ["saving", "uncertain", "capacity", "unavailable"].includes(state.status) || binding.index !== "synced")
      return {
        action: "captureState" as const,
        project,
        configured: true,
        capture: state.status,
        enabled: this.intake.enabled(),
        changed: false,
        detail:
          "Saving cannot resume until the existing setup and any earlier save are reviewed in Memory. Nothing was retried.",
      }
    if (cfg.enabled)
      return {
        action: "captureState" as const,
        project,
        configured: true,
        capture: state.status,
        enabled: true,
        changed: false,
        detail: "Automatic saving is already enabled.",
      }
    const approved = await vscode.window.showWarningMessage(
      "Resume saving useful conversation and completed-action information with your existing Memory preferences? Sensitive information stays excluded.",
      { modal: true },
      "Resume automatic saving",
    )
    check()
    if (!this.service.captureCurrent(binding) || !isDeepStrictEqual(this.intake.saved(binding), cfg))
      throw new Error("Original Memory preference changed during review")
    if (approved !== "Resume automatic saving")
      return {
        action: "captureState" as const,
        project,
        configured: true,
        capture: this.intake.snapshot(this.service.captureSnapshot()).status,
        enabled: this.intake.enabled(),
        changed: false,
        detail: "Future automatic saving remains paused. Any earlier save keeps its original status.",
      }
    const current = () => {
      check()
      const saved = this.intake.saved(binding)
      if (
        !this.service.captureCurrent(binding) ||
        (!isDeepStrictEqual(saved, cfg) && !isDeepStrictEqual(saved, { ...cfg, enabled: true }))
      )
        throw new Error("Original Memory preference changed during review")
      if (
        ["saving", "uncertain", "capacity", "unavailable"].includes(this.intake.snapshot(binding).status) ||
        this.service.captureSnapshot()?.index !== "synced"
      )
        throw new Error("An earlier Memory save or index needs review before automatic saving can resume")
    }
    current()
    await this.saveCapture({ ...cfg, enabled: true }, AbortSignal.any([signal, AbortSignal.timeout(35000)]), current)
    check()
    return {
      action: "captureState" as const,
      project,
      configured: true,
      capture: this.intake.snapshot(this.service.captureSnapshot()).status,
      enabled: this.intake.enabled(),
      changed: true,
      detail: "Automatic saving is enabled for new conversations. Earlier saves were not retried.",
    }
  }

  private async setupStatus() {
    return await this.service.status().catch((err: unknown): BrainResponse["state"] => {
      if (
        err instanceof ClosedRequired ||
        (err instanceof Failure &&
          ["managed_generation_conflict", "closed_pair_recovery_required", "control_uncertain"].includes(err.code))
      )
        return {
          configured: this.settings.version() !== undefined,
          status: "unavailable",
          results: [],
          code: err instanceof ClosedRequired ? "closed_pair_recovery_required" : err.code,
        }
      if (
        err instanceof Error &&
        err.message === "Original managed launch remains retained; restarted hosts cannot adopt or replay it"
      )
        return {
          configured: this.settings.version() !== undefined,
          status: "unavailable",
          code: "closed_pair_recovery_required",
          results: [],
        }
      throw err
    })
  }

  private async conversationSetup(
    row: Record<string, unknown>,
    project: string,
    session: string | undefined,
    signal: AbortSignal,
    guard: () => void,
  ) {
    if (!session) throw new Error("Memory setup requires its original conversation")
    const command = setupCommand(row)
    if (command.stage !== "cancel") await hydrate(this.service, this.control, await this.setupStatus(), signal, guard)
    this.onboarding ??= new SetupFlow({
      snapshot: async () => {
        const state = await this.setupStatus()
        return {
          configured: state.configured,
          root: state.root,
          recovery:
            state.status === "unavailable" &&
            [
              "managed_generation_conflict",
              "closed_pair_recovery_required",
              "control_uncertain",
              "setup_invalid",
            ].includes(state.code ?? ""),
          index: state.configured ? this.control.snapshot().status : "unchecked",
          capture: state.configured ? this.intake.snapshot(this.service.captureSnapshot()).status : "unavailable",
        }
      },
      prepared: async () => {
        const cfg = await this.prepared()
        return cfg
          ? {
              root: cfg.setup.root,
              capture: !!cfg.bundle.capture,
              fresh: !!cfg.bundle.fresh,
              identity: createHash("sha256").update(JSON.stringify(cfg.bundle)).digest("hex"),
            }
          : undefined
      },
      connect: async (check) => {
        check()
        const cfg = await this.prepared()
        check()
        if (!cfg) throw new Error("Installer-prepared Memory selection required")
        return this.setup(cfg, check)
      },
      notes: async (check) => {
        const cfg = await this.settings.load()
        check()
        if (!cfg) throw new Error("Reviewed Memory setup required")
        const saved = this.context.globalState.get<{ root: string; catalog: unknown }>(catalogKey)
        if (
          !saved ||
          saved.root !== cfg.setup.root ||
          Object.entries(cfg.setup.source_sha256).some(
            ([name, hash]) => parseCatalog(saved.catalog).source_sha256[name] !== hash,
          )
        ) {
          const prepared = await this.prepared()
          check()
          if (!prepared || prepared.setup.root !== cfg.setup.root || !(await this.catalog(prepared.catalog, check)))
            return false
        }
        await this.review(check)
        check()
        return this.control.snapshot().status === "approved"
      },
      index: async (check, _model, signal) => {
        await this.sync(check, signal)
        check()
        return this.control.snapshot().status === "synced"
      },
      capture: async (check, model, signal) => {
        const cfg = await this.prepared()
        check()
        const timeout = AbortSignal.timeout(35000)
        const active = signal ? AbortSignal.any([signal, timeout]) : timeout
        const binding = await this.service.captureSelection(active)
        check()
        const choices = cfg?.bundle.capture
          ? await pinned(cfg.bundle.capture, (value, digest) => this.intake.reviewed(value, digest))
          : model
            ? {
                version: 1 as const,
                enabled: true,
                root: binding.root,
                release: binding.release,
                zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                model: model.providerID + "/" + model.modelID,
                authorization: {
                  source: "raya.memory.conversationSetup",
                  sha256: createHash("sha256")
                    .update(JSON.stringify({ root: binding.root, release: binding.release, model }))
                    .digest("hex"),
                },
              }
            : undefined
        if (!choices) throw new Error("Original conversation model or prepared capture choices required")
        check()
        const answer = await vscode.window.showWarningMessage(
          `Allow Raya to ${choices.enabled ? "save useful conversation and completed-action information" : "keep automatic saving paused"} in ${binding.root} using your selected model? Sensitive information is excluded. You can review or pause saving in Memory.`,
          { modal: true },
          "Apply saving preference",
        )
        check()
        if (answer !== "Apply saving preference") return false
        await this.saveCapture(choices, active, check)
        check()
        return true
      },
    })
    return this.onboarding.run(command, project + "|" + session, project, signal, guard)
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
      await this.trackDream(body, proposals, cfg.setup.root, () => this.settings.current(cfg.setup))
      const review =
        "proposals" in proposals
          ? undefined
          : await explanation(cfg.setup.root, body.project, proposals, AbortSignal.timeout(15000))
      const status = await this.service.status()
      if (!this.authorized(cfg.setup, folder)) throw new Error("Original Memory review authority changed")
      post({ type: "secondBrainState", id: message.id, state: { ...status, proposals, review } })
    } catch {
      post({
        type: "secondBrainState",
        id: message.id,
        state: { configured: true, status: "unavailable", code: "proposal_review_required", results: [] },
      })
    }
  }

  private authorized(setup: Parameters<BrainSettings["current"]>[0], folder: vscode.WorkspaceFolder) {
    return (
      this.settings.current(setup) && vscode.workspace.isTrusted && !!vscode.workspace.getWorkspaceFolder(folder.uri)
    )
  }

  private async trackDream(
    body: BrainProposalCommand,
    result: BrainProposalResult,
    root: string,
    current: () => boolean,
  ) {
    if (!["read", "cancel", "apply", "edit"].includes(body.action) || "proposals" in result) return
    if (!current()) throw new Error("Memory setup changed before Dream review reconciliation")
    const settle = body.action === "edit" ? MemoryFiles.dreamProposal.revise : MemoryFiles.dreamProposal.reconcile
    await settle(root, body.project, result, AbortSignal.timeout(15000))
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
        `Apply the exact Second Brain changes shown for ${body.project}? Review SHA-256: ${body.digest}.`,
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
    const send = (state: BrainResponse["state"]) => {
      this.view = { id: message.id, state, post }
      post({
        type: "secondBrainState",
        id: message.id,
        state: {
          ...state,
          control: this.control.snapshot(),
          capture: {
            ...this.intake.snapshot(this.service.captureSnapshot()),
            enabled: this.intake.enabled(),
            lastSaved: this.intake.lastSaved(this.service.captureSnapshot()),
          },
        },
      })
    }
    try {
      if (message.action === "setup") await this.setup()
      if (message.action === "disconnect") {
        await this.control.stop()
        await this.service.disconnect()
      }
      if (message.action === "review") await this.review()
      if (message.action === "controlSetup") await this.catalog()
      if (message.action === "sync") await this.sync()
      if (message.action === "disable") await this.control.pause((value) => this.confirm(value, "Disable policy"))
      if (message.action === "cancel" && this.current?.id === message.target)
        await this.service.stop(this.current.owner)
      if (message.action === "search" || message.action === "context") {
        this.indexed()
        await this.query(message, send)
        return
      }
      if (message.action === "check") {
        const owner = {}
        this.current = { id: message.id, owner }
        await this.service.run(
          undefined,
          (state) => {
            if (state.status === "ready" && state.control) this.control.observe(state.control)
            send(state)
          },
          owner,
        )
        return
      }
      if (await this.recovery(message.action, send)) return
      send(await this.service.status())
    } catch (err) {
      const pending = this.settings.pending() !== undefined
      const configured =
        pending || err instanceof ClosedRequired
          ? this.settings.version() !== undefined
          : await this.settings.load().then(
              (value) => !!value,
              () => false,
            )
      send({
        configured,
        status: "unavailable",
        code: pending ? "control_uncertain" : this.code(err),
        results: [],
      })
    }
  }

  private code(err: unknown) {
    if (err instanceof ClosedRequired) return "closed_pair_recovery_required"
    if (err instanceof Failure) return err.code
    return "setup_invalid"
  }

  private indexed() {
    if (this.control.snapshot().status !== "synced")
      throw new Failure("source_index_required", "Approve and index your notes before searching", 0)
  }

  private async recovery(action: BrainRequest["action"], send: (state: BrainResponse["state"]) => void) {
    if (action === "resume") {
      await this.resume()
      send(await this.service.status())
      return true
    }
    if (action === "reconcile") {
      send(await this.service.reconcile())
      return true
    }
    if (action === "archive") {
      await this.archive()
      send(await this.service.status())
      return true
    }
    if (action !== "repair") return false
    await this.repair()
    send(await this.service.status())
    return true
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

  private async sync(check: () => void = () => {}, parent?: AbortSignal) {
    check()
    await this.control.sync(
      async (value) => {
        check()
        const accepted = await this.confirm(value, "Sync now")
        check()
        return accepted
      },
      async (expected, signal, close) => {
        check()
        const active = parent ? AbortSignal.any([parent, signal]) : signal
        const cfg = await this.settings.load()
        if (!cfg) throw new Error("Memory setup required")
        if (cfg.setup.version === 2) {
          await this.service.sync(expected, active, close)
          return
        }
        const client = new BrainClient(cfg.key, cfg.setup)
        try {
          await client.sync(expected, active, async (request) => {
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
      check,
    )
    check()
  }

  private async chooseSetup(check: () => void) {
    const files = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "Memory setup": ["json"] },
      title: "Select a reviewed local Memory setup manifest",
    })
    check()
    if (!files?.[0] || files[0].scheme !== "file") return undefined
    const cfg = await manifest(files[0].fsPath)
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
    check()
    if (!mode) return undefined
    if (mode.value !== "managed") return { setup: cfg, managed: undefined }
    const launch = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "Managed launch descriptor": ["json"] },
      title: "Select the reviewed managed Memory launch",
    })
    check()
    if (!launch?.[0] || launch[0].scheme !== "file") return undefined
    const managed = await metadata(launch[0].fsPath, descriptor)
    await selection(managed, cfg)
    check()
    return { setup: cfg, managed }
  }

  private async setup(prepared?: PreparedSetup, check: () => void = () => {}) {
    check()
    if (prepared?.bundle.fresh) {
      if (!(await this.archive(prepared.bundle.fresh.path, check, prepared.bundle.fresh.sha256))) return false
      check()
      return this.catalog(prepared.catalog, check)
    }
    await this.control.stop()
    check()
    const selected = prepared ?? (await this.chooseSetup(check))
    if (!selected) return false
    const cfg = selected.setup
    const managed = selected.managed
    check()
    const accepted = await vscode.window.showWarningMessage(
      `Trust ${cfg.origin} for standalone search of ${cfg.root}? ${managed ? "Check, Search or Sync starts the service. Raya stops it when Memory is disconnected or Raya closes." : "You start and stop the service yourself."} Search results stay in this panel. This does not approve source indexing or enable capture.`,
      { modal: true },
      "Trust service",
    )
    check()
    if (accepted !== "Trust service") return false
    const key = await vscode.window.showInputBox({
      password: true,
      ignoreFocusOut: true,
      prompt: "Local Memory service credential (stored only in VS Code Secret Storage)",
    })
    check()
    if (key === undefined) return false
    await this.service.configure(async () => {
      check()
      await this.settings.save(cfg, key, managed)
      check()
    })
    check()
    return prepared ? this.catalog(prepared.catalog, check) : true
  }

  private async repair() {
    if (!vscode.workspace.isTrusted) throw new Error("Trusted workspace required for Memory repair")
    const selected = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "Failed search observation": ["json"] },
      title: "Select the reviewed original failed-search observation",
    })
    if (!selected?.[0] || selected[0].scheme !== "file") return
    await this.service.repair(selected[0].fsPath, async (review) => {
      const action = review.outcome === "cancelled" ? "Recover interrupted search" : "Recover failed search"
      const count = review.downstream.length
      const downstream = count
        ? `${count} reviewed failed downstream request${count === 1 ? " that never started a worker" : "s that never started workers"}`
        : "no downstream requests"
      const accepted = await vscode.window.showWarningMessage(
        `Recover the saved Memory setup for ${review.root}? Original search ${review.request} ended ${review.outcome} with ${downstream}, and its original producer pair closed cleanly. Trust the reviewed observation SHA-256 ${review.observation.sha256}. Previous setup and request metadata are retained in an audit. This administrative recovery does not settle or retry the original HTTP request; source indexing and capture remain separate actions.`,
        { modal: true },
        action,
      )
      return accepted === action
    })
  }

  private async archive(file?: string, check: () => void = () => {}, expected?: string) {
    check()
    if (!vscode.workspace.isTrusted) throw new Error("Trusted workspace required for Memory recovery")
    const selected = file
      ? undefined
      : await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { "Fresh Memory setup": ["json"] },
          title: "Select the reviewed fresh-start Memory setup",
        })
    check()
    if (!file && (!selected?.[0] || selected[0].scheme !== "file")) return false
    let approved = false
    await this.service.archive(file ?? selected![0].fsPath, async (review) => {
      check()
      if (expected && review.selection.sha256 !== expected) throw new Error("Prepared fresh Memory selection changed")
      const accepted = await vscode.window.showWarningMessage(
        `Archive the prior setup and start fresh for ${review.root}? ${review.outcome === "completed" ? `Search ${review.request} completed, but its original worker release receipt is unavailable. Its completion record, downstream receipts and recovery record will remain preserved; this action does not settle that request.` : review.outcome === "unknown" ? "Earlier startup work remains unverified; this action does not claim that its work settled." : `Search ${review.request} failed without downstream requests.`} The old setup, credential reference and request records remain in a quarantined audit. Trust fresh setup SHA-256 ${review.selection.sha256} and observation ${review.observation.sha256}. New service addresses and request folders will be used. Your notes are preserved; prior work is not retried.`,
        { modal: true },
        "Archive and start fresh",
      )
      check()
      approved = accepted === "Archive and start fresh"
      return approved
    })
    check()
    return approved
  }

  private async resume() {
    if (!vscode.workspace.isTrusted) throw new Error("Trusted workspace required for Memory recovery")
    await this.service.resume(async (review) => {
      const accepted = await vscode.window.showWarningMessage(
        `Restore the saved shutdown state for ${review.root}? Both original Memory producers closed successfully. Closure SHA-256: ${review.closed.sha256}. The previous setup is retained in an audit. This permits a fresh service start; it does not settle or replay requests, index notes or enable capture.`,
        { modal: true },
        "Restore closed Memory setup",
      )
      return accepted === "Restore closed Memory setup"
    })
  }

  private async recoverCapture() {
    if (!vscode.workspace.isTrusted) throw new Error("Trusted workspace required for Memory recovery")
    const choices = this.intake
      .recoverable()
      .map((turn) => ({ label: turn.id, description: turn.root, detail: `Original message: ${turn.messageID}`, turn }))
    if (!choices.length) throw new Error("No interrupted capture is available for committed-effect review")
    const selected = await vscode.window.showQuickPick(choices, {
      title: "Review an interrupted Memory save",
      ignoreFocusOut: true,
    })
    if (!selected) return
    const key = `raya.secondBrain.committedCaptureRecovery.${selected.turn.id}`
    const retained = this.context.globalState.get<{ phase: string }>(key)
    const result =
      retained?.phase === "applied"
        ? this.settings.pending() ||
          this.context.globalState.get<{ format?: string }>("raya.secondBrain.committedCaptureRecovery.pending")
            ?.format === "raya.memory.capture-index.recovery.pending"
          ? await this.service.recoverIndex(selected.turn, async (review) => {
              if (!vscode.workspace.isTrusted || this.closing)
                throw new Error("Memory recovery selection is unavailable")
              const accepted = await vscode.window.showWarningMessage(
                `Retain failed index ${review.request} and recover the setup for the original verified save ${selected.turn.id}? Its exact failed request and downstream evidence remain in a separate audit linked to the applied original save recovery. This does not retry indexing or confirm that indexing succeeded. The original save and notes remain unchanged.`,
                { modal: true },
                "Retain failed index and recover setup",
              )
              if (!vscode.workspace.isTrusted || this.closing) throw new Error("Memory recovery selection changed")
              return accepted === "Retain failed index and recover setup"
            })
          : this.settings.upgrading()
            ? await this.service.upgradeCapture(selected.turn)
            : await this.settings.reviewCapture(this.context.extensionPath, selected.turn)
        : await this.service.recoverCapture(selected.turn, async (review) => {
            if (!vscode.workspace.isTrusted || this.closing) throw new Error("Memory recovery selection is unavailable")
            const accepted = await vscode.window.showWarningMessage(
              `The original save ${review.capture} is present in ${review.root}. Its note bytes, change journal, policy and original completed request agree, and both original services closed successfully.${"indexFailure" in review ? " Its separate index request failed before creating a worker and remains in the audit; this does not confirm that indexing succeeded." : ""} Recover the setup for this verified save? Indexing requires the separate Index a Recovered Memory Save command. The original requests and capture history remain in the audit; the save will not be repeated.`,
              { modal: true },
              "Recover committed save",
            )
            if (!vscode.workspace.isTrusted || this.closing) throw new Error("Memory recovery selection changed")
            return accepted === "Recover committed save"
          })
    if (!result) return
    disposeHistory(result)
    await vscode.window.showInformationMessage(
      "The original Memory save recovery is retained. Indexing remains pending; use Index a Recovered Memory Save when ready.",
    )
  }

  private retireIndex() {
    const held = this.indexing
    if (!held) return Promise.resolve()
    held.controller.abort(new Error("Memory indexing intake is retired"))
    return held.job
  }

  private indexCapture(maximum = 600000) {
    // Local helper (15s), selection (35s), and sync (185s) observation fences
    // do not bound repeated ancestry work or original retirement. This separate
    // ten-minute acceptance policy excludes native user decisions and never races
    // a timeout return against the original pending work.
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 600000)
      return Promise.reject(new Error("Invalid recovered-index acceptance policy"))
    if (!vscode.workspace.isTrusted || this.closing)
      return Promise.reject(new Error("Trusted workspace required for Memory indexing"))
    if (this.indexing) return this.indexing.job
    const held = { controller: new AbortController(), job: Promise.resolve() }
    this.indexing = held
    const work = Promise.resolve()
      .then(() =>
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Index a recovered Memory save", cancellable: true },
          async (progress, cancellation) => {
            let clock = performance.now()
            let spent = 0
            let paused = false
            let stage = "Choose the original recovered save"
            const elapsed = () => spent + (paused ? 0 : performance.now() - clock)
            const report = () =>
              progress.report({
                message: held.controller.signal.aborted
                  ? `Acceptance cancelled; waiting for original work and readers to join · ${Math.floor(elapsed() / 1000)}s active work`
                  : `${stage} · ${Math.floor(elapsed() / 1000)}s active work`,
              })
            const cancel = () => {
              held.controller.abort(
                new Error("Recovered-save indexing was cancelled; original retirement remains required"),
              )
              report()
            }
            const check = () => {
              if (elapsed() >= maximum && !held.controller.signal.aborted) {
                held.controller.abort(
                  new Error("Recovered-save indexing exceeded its 10-minute active-work acceptance limit"),
                )
                report()
              }
              held.controller.signal.throwIfAborted()
              if (this.indexing !== held || !vscode.workspace.isTrusted || this.closing)
                throw new Error("Memory recovery selection changed")
            }
            const scope: IndexScope = {
              signal: held.controller.signal,
              check,
              stage: (message) => {
                stage = message
                report()
                check()
              },
              wait: async (body) => {
                check()
                spent = elapsed()
                paused = true
                report()
                try {
                  const result = await body()
                  check()
                  return result
                } finally {
                  clock = performance.now()
                  paused = false
                }
              },
            }
            const off = cancellation.onCancellationRequested(cancel)
            held.controller.signal.addEventListener("abort", report)
            const timer = setInterval(
              () => {
                if (!paused && elapsed() >= maximum && !held.controller.signal.aborted)
                  held.controller.abort(
                    new Error("Recovered-save indexing exceeded its 10-minute active-work acceptance limit"),
                  )
                report()
              },
              Math.min(1000, maximum),
            )
            if (cancellation.isCancellationRequested) cancel()
            try {
              check()
              await this.indexSave(scope)
              check()
            } finally {
              clearInterval(timer)
              off.dispose()
              held.controller.signal.removeEventListener("abort", report)
            }
          },
        ),
      )
      .finally(() => {
        held.controller.abort()
        if (this.indexing === held) this.indexing = undefined
      })
    held.job = work
    return work
  }

  private async indexSave(scope: IndexScope) {
    scope.check()
    const choices = this.intake.recoverable().filter((turn) => {
      const audit = this.context.globalState.get<{ format: string; version: number; phase: string }>(
        `raya.secondBrain.committedCaptureRecovery.${turn.id}`,
      )
      return (
        audit?.format === "raya.memory.committed-capture.recovery" && audit.version === 1 && audit.phase === "applied"
      )
    })
    if (!choices.length) throw new Error("No applied Memory save recovery is available for indexing")
    const selected = await scope.wait(() =>
      vscode.window.showQuickPick(
        choices.map((turn) => ({
          label: turn.id,
          description: turn.root,
          detail: `Original message: ${turn.messageID}`,
          turn,
        })),
        { title: "Index a recovered Memory save", ignoreFocusOut: true },
      ),
    )
    scope.check()
    if (!selected) return
    scope.stage("Verify original save and retained source history")
    const reviewed = await this.settings.reviewCapture(this.context.extensionPath, selected.turn, scope.check)
    try {
      scope.check()
      if (!(await this.confirmCapture(reviewed, selected.turn, scope))) return
      scope.check()
      await scope.wait(() =>
        vscode.window.showInformationMessage(
          "The recovered Memory save's verified current source policy is indexed. Its original recovery and request audits are retained.",
        ),
      )
    } finally {
      disposeHistory(reviewed)
    }
  }

  private async reconcileRefusal() {
    const check = () => {
      if (!vscode.workspace.isTrusted || this.closing) throw new Error("Native capture refusal review is unavailable")
    }
    check()
    const files = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFolders: false,
      filters: { "Original catalog refusal review": ["json"] },
      title: "Review a refused automatic Memory save",
    })
    if (!files?.[0] || files[0].scheme !== "file") return
    const input = await metadata(files[0].fsPath, (value) => value)
    const proof = await refusedCapture(input, this.context.globalState)
    check()
    const accepted = await vscode.window.showWarningMessage(
      `Save ${proof.original.id} was refused before native control could start under its exact reviewed source and catalog bindings. Retain the original uncertain record and diagnostic in an audit, and mark that attempt skipped so new conversations may save? The original conversation will not be retried. This does not settle a transport request or confirm indexing.`,
      { modal: true },
      "Retain refusal and allow new saves",
    )
    if (accepted !== "Retain refusal and allow new saves") return
    check()
    await this.service.configure(() => this.intake.reconcileRefusal(input, check).then(() => undefined), false)
    await vscode.window.showInformationMessage(
      "The original refused save is retained in its audit. Only new conversations may save.",
    )
  }

  private async abandonReservation() {
    const check = () => {
      if (!vscode.workspace.isTrusted || this.closing) throw new Error("Native reservation review is unavailable")
    }
    check()
    const rows = this.intake.reservations()
    const picked = await vscode.window.showQuickPick(
      rows.map((row) => ({
        label: row.id,
        description: row.sessionID,
        detail: `Reserved attempt · ${row.root}`,
      })),
      {
        title: "Review an interrupted Memory extraction",
        placeHolder: "Choose the original reserved attempt to abandon",
      },
    )
    if (!picked) return
    const proof = await this.intake.reviewReservation(picked.label, this.context.extensionPath)
    check()
    const accepted = await vscode.window.showWarningMessage(
      `Attempt ${proof.original.id} remains reserved and has no grant or active save in this host. Its exact current runtime is closed with verified producer absence. Retain the original attempt and closure in an audit and mark it skipped? This saves no facts, settles no transport request and never retries this conversation. Only new conversations may save.`,
      { modal: true },
      "Retain attempt and allow new saves",
    )
    if (accepted !== "Retain attempt and allow new saves") return
    check()
    await this.service.configure(
      () => this.intake.abandonReservation(picked.label, this.context.extensionPath, check).then(() => undefined),
      false,
    )
    await vscode.window.showInformationMessage(
      "The interrupted extraction is retained in its audit. Its original conversation will not be retried.",
    )
  }

  private async confirmCapture(
    result: Awaited<ReturnType<BrainSettings["reviewCapture"]>>,
    turn: Parameters<BrainSettings["reviewCapture"]>[1],
    scope?: IndexScope,
  ) {
    const retained = [result]
    try {
      const check = () => {
        scope?.check()
        if (!vscode.workspace.isTrusted || this.closing) throw new Error("Memory recovery selection changed")
      }
      check()
      const active = { value: result }
      const fresh = async (value = active.value) => {
        check()
        await freshHistory(value, check)
        check()
      }
      await fresh()
      const policy = currentPolicy(result)
      const resources = async () => {
        scope?.stage("Verify source history and indexing resources")
        await fresh()
        const current = await this.settings.load()
        await fresh()
        if (!current?.managed) throw new Error("Reviewed managed Memory setup required for indexing")
        await admission(descriptor(current.managed).python)
        await fresh()
      }
      await resources()
      let accepted = false
      await this.control.sync(
        async (review) => {
          await fresh()
          if (review.digest !== policy) throw new Error("Recovered capture source policy changed")
          scope?.stage("Review the verified indexing policy")
          const modal = () =>
            vscode.window.showWarningMessage(
              `Start a new indexing operation for recovered save ${result.capture}? The original save will not be repeated. This indexes only the verified enabled source policy below. Failed historical requests remain in their audits.\n\n${review.text}`,
              { modal: true },
              "Index recovered save",
            )
          const answer = scope ? await scope.wait(modal) : await modal()
          await fresh()
          accepted = answer === "Index recovered save"
          return accepted
        },
        async (expected, signal, close) => {
          await resources()
          if (signal.aborted) throw new Error("Recovered-save indexing was cancelled before publication")
          if (expected !== policy) throw new Error("Recovered capture source policy changed")
          await fresh()
          scope?.stage("Index verified notes; original native joins remain required")
          const parent = scope ? AbortSignal.any([signal, scope.signal]) : signal
          check()
          await this.service.sync(expected, parent, close)
          check()
          scope?.stage("Verify original indexing completion and source history")
          disposeHistory(active.value)
          const reviewed = await this.settings.reviewCapture(this.context.extensionPath, turn, check)
          retained.push(reviewed)
          check()
          if (
            currentPolicy(reviewed) !== policy ||
            !isDeepStrictEqual({ ...reviewed, producer: undefined }, { ...result, producer: undefined })
          )
            throw new Error("Original recovered capture changed after indexing")
          await fresh(reviewed)
          active.value = reviewed
          await fresh()
        },
        check,
      )
      await fresh()
      if (!accepted) return false
      disposeHistory(active.value)
      scope?.stage("Verify current index selection before confirmation")
      const reviewed = await this.settings.reviewCapture(this.context.extensionPath, turn, check)
      retained.push(reviewed)
      await fresh(reviewed)
      if (currentPolicy(reviewed) !== policy) throw new Error("Recovered capture source policy changed")
      check()
      const binding = await this.service.captureSelection(
        scope ? AbortSignal.any([AbortSignal.timeout(35000), scope.signal]) : AbortSignal.timeout(35000),
        policy,
      )
      await fresh(reviewed)
      await this.service.configure(async () => {
        scope?.stage("Publish exact original recovery confirmation")
        await fresh(reviewed)
        await this.intake.confirmRecovery(reviewed, binding, () => {
          check()
          if (!this.service.captureCurrent(binding)) throw new Error("Recovered capture generation changed")
        })
        await fresh(reviewed)
      }, false)
      await fresh(reviewed)
      return true
    } finally {
      for (const value of retained) disposeHistory(value)
    }
  }

  private async review(check: () => void = () => {}) {
    check()
    const cfg = await this.settings.load()
    if (!cfg) throw new Error("Memory setup required")
    const names = await choices(cfg.setup.root)
    check()
    if (!names.length) throw new Error("No eligible Markdown notes found")
    const picked = await vscode.window.showQuickPick(
      names.map((name) => ({ label: name })),
      {
        canPickMany: true,
        ignoreFocusOut: true,
        title: "Choose the notes Raya may search",
        placeHolder: "Choose the complete set. Previously selected notes you omit will be removed. Review follows.",
      },
    )
    check()
    if (picked === undefined) return
    const selected = picked.map((item) => item.label)
    if (!selected.length || selected.length > 128) throw new Error("Select 1–128 relative source files")
    if (!this.settings.current(cfg.setup)) throw new Error("Memory setup changed during note selection")
    const enabled = await vscode.window.showQuickPick(
      [
        { label: "Enable this reviewed source policy", value: true },
        { label: "Keep this source policy disabled", value: false },
      ],
      { title: "Memory source policy enablement" },
    )
    check()
    if (!enabled) return
    await this.control.review(selected, enabled.value, async (value) => {
      check()
      const accepted = await this.confirm(value, "Approve policy")
      check()
      return accepted
    })
    check()
  }

  private async catalog(prepared?: ReturnType<typeof parseCatalog>, check: () => void = () => {}) {
    check()
    await this.control.stop()
    check()
    const selected = prepared
      ? undefined
      : await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { "Memory control catalog": ["json"] },
          title: "Select the reviewed local Memory control release",
        })
    check()
    if (!prepared && (!selected?.[0] || selected[0].scheme !== "file")) return false
    const catalog = prepared ?? (await metadata(selected![0].fsPath, parseCatalog))
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
    check()
    if (accepted !== "Trust control release") return false
    await this.service.configure(async () => {
      check()
      const current = await this.settings.load()
      if (!current || !this.settings.current(cfg.setup) || JSON.stringify(current.setup) !== JSON.stringify(cfg.setup))
        throw new Error("Memory setup changed during control review")
      await this.context.globalState.update(catalogKey, { root: cfg.setup.root, catalog })
      if (!this.settings.current(cfg.setup)) throw new Error("Memory setup changed during control publication")
      check()
    }, false)
    return true
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
        `${action === "Sync now" ? "Start local indexing for" : "Publish"} the complete policy shown in the read-only review? Enabled: ${value.enabled}. Policy SHA-256: ${value.digest}.`,
        { modal: true },
        action,
      )
      return answer === action && !document.isClosed && unchanged(value.text, document.getText())
    } finally {
      provider.dispose()
    }
  }
}
