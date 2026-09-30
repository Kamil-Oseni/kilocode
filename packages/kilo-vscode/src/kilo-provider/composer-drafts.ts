import { createHash, randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { canonicalizePath, samePath } from "../agent-manager/project/paths"
import type {
  ComposerDraftAccepted,
  ComposerDraftExtensionMessage,
  ComposerDraftFlushed,
  ComposerDraftRequest,
  ComposerDraftWebviewMessage,
  DraftCapture,
  DraftCode,
  DraftEntry,
  DraftIdentity,
  DraftTarget,
  DraftToken,
  DraftContent,
} from "../shared/composer-drafts-messages"

export interface DraftBackend {
  list(scope: { workspace: string; projectID?: string; box: string }): Promise<{ entries: DraftEntry[] }>
  load(identity: DraftIdentity): Promise<{ entry: DraftEntry | null }>
  save(
    identity: DraftIdentity,
    expected: DraftToken | undefined,
    content: DraftContent,
    mutation: string,
  ): Promise<{ entry: DraftEntry }>
  clear(identity: DraftIdentity, expected: DraftToken, mutation: string): Promise<{ entry: DraftEntry }>
  promote(
    from: DraftIdentity,
    to: DraftIdentity,
    source: DraftToken,
    target: DraftToken | undefined,
    mutation: string,
  ): Promise<{ source: DraftEntry; target: DraftEntry }>
}
type Context = {
  backend: () => DraftBackend | undefined
  scope: (target: DraftTarget) => Promise<DraftIdentity>
  post: (message: ComposerDraftExtensionMessage) => void
  generation: () => number
  owners: () => Array<{ box: string; owner: string }>
  message: (
    sessionID: string,
    messageID: string,
    directory: string,
  ) => Promise<{ role: string; id: string; sessionID: string } | undefined>
}
const panes = new Set<ComposerDrafts>()
let registry = 0
const same = (a: DraftToken, b: DraftToken) => a.generation === b.generation && a.revision === b.revision
const codes = new Set<DraftCode>([
  "invalid",
  "scope",
  "corrupt",
  "missing",
  "conflict",
  "capacity",
  "admission",
  "disconnected",
  "stale",
  "timeout",
  "changed",
  "promotion",
  "uncertain",
  "unavailable",
])
function code(err: unknown): DraftCode {
  if (err && typeof err === "object" && "code" in err && codes.has(err.code as DraftCode)) return err.code as DraftCode
  return "unavailable"
}
function refused(value: DraftCode): never {
  throw Object.assign(new Error("Composer draft operation refused"), { code: value })
}
export function composerOwner(directory: string, projectID: string) {
  const path = canonicalizePath(directory)
  return createHash("sha256")
    .update(JSON.stringify({ directory: process.platform === "win32" ? path.toLowerCase() : path, projectID }))
    .digest("hex")
}
export function composerScopes(
  target: DraftTarget,
  ctx: {
    scopes?: () => Array<{ box: string; directory: string }>
    directory: (sessionID?: string) => string
    sessionID?: string
  },
) {
  return (
    ctx.scopes?.() ??
    ["prompt:default", "sidebar:fallback", "sidebar:new-task"].map((box) => ({
      box,
      directory: ctx.directory(target.sessionID ?? ctx.sessionID),
    }))
  )
}
export async function composerIdentity(
  target: DraftTarget,
  ctx: {
    scopes: () => Array<{ box: string; directory: string }>
    current: () => boolean
    ambiguous: (sessionID: string) => boolean
    project: (directory: string) => Promise<string>
    session: (sessionID: string, directory: string) => Promise<{ projectID: string; directory: string }>
  },
): Promise<DraftIdentity> {
  const scope = ctx.scopes().find((item) => item.box === target.box)
  if (
    !ctx.current() ||
    !scope ||
    typeof target.key !== "string" ||
    !target.key ||
    target.key.length > 4096 ||
    Boolean(target.sessionID) === Boolean(target.pendingID) ||
    (target.sessionID && ctx.ambiguous(target.sessionID))
  )
    refused("invalid")
  const directory = realpathSync.native(scope.directory)
  const projectID = await ctx.project(directory)
  const session = target.sessionID ? await ctx.session(target.sessionID, directory) : undefined
  const selected = ctx.scopes().find((item) => item.box === target.box)
  if (
    !ctx.current() ||
    !selected ||
    !samePath(directory, realpathSync.native(selected.directory)) ||
    (target.projectID && target.projectID !== projectID) ||
    (session && (session.projectID !== projectID || !samePath(realpathSync.native(session.directory), directory)))
  )
    refused("stale")
  return { ...target, workspace: directory, projectID }
}
type Sending = {
  capture: DraftCapture
  identity: DraftIdentity
  token: DraftToken
  sessionID: string
  messageID: string
  epoch: string
  generation: number
}

/** One controller per live host view. The registry deliberately spans all views in this extension host. */
export class ComposerDrafts {
  private epoch?: string
  private sequence = 0
  private pending = 0
  private disposed = false
  private sending = new Map<string, Sending>()
  private flushes = new Map<string, { resolve: (value: ComposerDraftFlushed) => void; reject: (err: Error) => void }>()
  constructor(private readonly ctx: Context) {}
  private current(epoch: string, generation: number) {
    return !this.disposed && this.epoch === epoch && this.ctx.generation() === generation && !!this.ctx.backend()
  }
  state() {
    if (this.disposed) return
    this.sequence++
    for (const item of this.flushes.values()) item.reject(new Error("Composer drafts changed connection"))
    this.flushes.clear()
    if (!this.epoch) return
    this.ctx.post({
      type: "composerDraftState",
      epoch: this.epoch,
      generation: this.ctx.generation(),
      connected: !!this.ctx.backend(),
      owners: this.ctx.owners(),
    })
  }
  async ready() {
    this.state()
    await this.reconcile()
  }
  async reconcile() {
    for (const item of this.sending.values()) {
      const generation = this.ctx.generation()
      const epoch = this.epoch
      if (!epoch || !this.ctx.backend()) return
      if (this.ctx.owners().find((owner) => owner.box === item.identity.box)?.owner !== item.capture.owner) continue
      const identity = await this.ctx.scope(item.identity)
      if (identity.workspace !== item.identity.workspace || identity.projectID !== item.identity.projectID) continue
      const info = await this.ctx.message(item.sessionID, item.messageID, identity.workspace).catch(() => undefined)
      if (
        !this.current(epoch, generation) ||
        info?.role !== "user" ||
        info.id !== item.messageID ||
        info.sessionID !== item.sessionID
      )
        continue
      item.epoch = epoch
      item.generation = generation
      await this.accepted(item.sessionID, item.messageID, info.role)
    }
  }
  async handle(message: ComposerDraftWebviewMessage) {
    if (message.type === "composerDraftPane") {
      if (this.disposed) return
      registry++
      this.epoch = message.active ? message.epoch : undefined
      if (message.active) panes.add(this)
      if (!message.active) panes.delete(this)
      this.state()
      return
    }
    if (message.type === "composerDraftFlushed") {
      if (this.current(message.epoch, message.generation)) this.flushes.get(message.requestID)?.resolve(message)
      return
    }
    this.sequence++
    const epoch = message.epoch
    const generation = message.generation
    const backend = this.ctx.backend()
    const box =
      message.type === "composerDraftList"
        ? message.box
        : message.type === "composerDraftPromote"
          ? message.from.box
          : message.identity.box
    if (this.ctx.owners().find((item) => item.box === box)?.owner !== message.owner) {
      this.reply(message, { error: "scope" })
      return
    }
    if (!backend || !this.current(epoch, generation)) {
      this.reply(message, { error: backend ? "stale" : "disconnected" })
      return
    }
    this.pending++
    try {
      const result = await this.execute(backend, message)
      if (!this.current(epoch, generation)) return
      this.reply(message, result)
    } catch (err) {
      if (this.current(epoch, generation)) this.reply(message, { error: code(err) })
    } finally {
      this.pending--
    }
  }
  private reply(
    message: ComposerDraftRequest,
    result: {
      entry?: DraftEntry | null
      entries?: DraftEntry[]
      source?: DraftEntry
      target?: DraftEntry
      error?: DraftCode
    },
  ) {
    this.ctx.post({
      type: "composerDraftResult",
      requestID: message.requestID,
      epoch: message.epoch,
      generation: message.generation,
      operation: message.type,
      owner: message.owner,
      ...result,
    })
  }
  private async execute(backend: DraftBackend, message: ComposerDraftRequest) {
    if (message.type === "composerDraftList") {
      const scope = await this.ctx.scope({ box: message.box, key: "list", pendingID: "list" })
      const result = await backend.list({ workspace: scope.workspace, projectID: scope.projectID, box: scope.box })
      const entries = await Promise.all(result.entries.map((entry) => this.restored(backend, entry)))
      return {
        entries: entries.flatMap((item) => (item.entry ? [item.entry] : [])),
        error: entries.some((item) => item.error) ? ("uncertain" as const) : undefined,
      }
    }
    if (message.type === "composerDraftPromote") {
      const from = await this.ctx.scope(message.from)
      const to = await this.ctx.scope(message.to)
      if (from.workspace !== to.workspace || from.projectID !== to.projectID || from.box !== to.box) refused("invalid")
      if (!this.current(message.epoch, message.generation)) refused("stale")
      return backend.promote(from, to, message.source, message.target, message.mutation)
    }
    const identity = await this.ctx.scope(message.identity)
    if (message.type === "composerDraftLoad") return this.restored(backend, (await backend.load(identity)).entry)
    if (message.type === "composerDraftSave") {
      const prior = (await backend.load(identity)).entry
      if (prior?.content && prior.mutation.startsWith("send:") && message.reviewed !== true) refused("uncertain")
      await this.owned(identity)
      if (!this.current(message.epoch, message.generation)) refused("stale")
      return backend.save(identity, message.expected, message.content, message.mutation)
    }
    if (!this.current(message.epoch, message.generation)) refused("stale")
    return backend.clear(identity, message.expected, message.mutation)
  }
  private async owned(identity: DraftIdentity) {
    const current = await this.ctx.scope(identity)
    if (current.workspace !== identity.workspace || current.projectID !== identity.projectID) refused("stale")
  }
  private async restored(
    backend: DraftBackend,
    entry: DraftEntry | null,
  ): Promise<{ entry: DraftEntry | null; error?: DraftCode }> {
    if (!entry?.content || !entry.mutation.startsWith("send:")) return { entry }
    const sessionID = entry.identity.sessionID
    const messageID = entry.mutation.slice(5)
    if (!sessionID || !messageID) return { entry, error: "uncertain" }
    const info = await this.ctx.message(sessionID, messageID, entry.identity.workspace).catch(() => undefined)
    if (info?.role !== "user" || info.sessionID !== sessionID || info.id !== messageID)
      return { entry, error: "uncertain" }
    await this.owned(entry.identity)
    return backend.clear(entry.identity, entry.token, `accepted:${messageID}`)
  }
  async validate(capture: DraftCapture) {
    if (this.ctx.owners().find((item) => item.box === capture.identity.box)?.owner !== capture.owner) refused("scope")
    if (!this.current(capture.epoch, capture.generation)) refused("stale")
    const backend = this.ctx.backend()
    if (!backend) refused("disconnected")
    const identity = await this.ctx.scope(capture.identity)
    const { entry } = await backend.load(identity)
    if (
      !this.current(capture.epoch, capture.generation) ||
      !entry?.content ||
      !same(entry.token, capture.token) ||
      entry.mutation !== capture.mutation ||
      entry.digest !== capture.digest
    )
      refused("conflict")
    if (entry.mutation.startsWith("send:")) refused("uncertain")
  }
  async prepare(capture: DraftCapture, sessionID: string, messageID: string): Promise<void> {
    const backend = this.ctx.backend()
    const epoch = this.epoch
    const generation = this.ctx.generation()
    if (!backend || !epoch) refused("disconnected")
    if (this.ctx.owners().find((item) => item.box === capture.identity.box)?.owner !== capture.owner) refused("scope")
    if (capture.epoch !== epoch || capture.generation !== generation) refused("stale")
    this.pending++
    this.sequence++
    try {
      const from = await this.ctx.scope(capture.identity)
      if (from.sessionID && from.sessionID !== sessionID) refused("invalid")
      const { entry } = await backend.load(from)
      if (
        !entry?.content ||
        !same(entry.token, capture.token) ||
        entry.mutation !== capture.mutation ||
        entry.digest !== capture.digest
      )
        refused("conflict")
      if (entry.mutation.startsWith("send:")) refused("uncertain")
      const identity = await this.ctx.scope({ box: from.box, key: `${from.box}:session:${sessionID}`, sessionID })
      await this.owned(from)
      if (!this.current(epoch, generation)) refused("stale")
      const target = from.pendingID
        ? (await backend.promote(from, identity, entry.token, undefined, `send:${messageID}`)).target
        : (await backend.save(from, entry.token, entry.content, `send:${messageID}`)).entry
      if (target.identity.sessionID !== sessionID || !this.current(epoch, generation)) refused("stale")
      this.sending.set(messageID, {
        capture,
        identity: target.identity,
        token: target.token,
        sessionID,
        messageID,
        epoch,
        generation,
      })
      this.ctx.post({ type: "composerDraftPrepared", epoch, generation, sessionID, messageID, capture, entry: target })
    } finally {
      this.pending--
    }
  }
  async accepted(sessionID: string, messageID: string, role: string): Promise<void> {
    const item = this.sending.get(messageID)
    if (!item || role !== "user" || item.sessionID !== sessionID || !this.current(item.epoch, item.generation)) return
    const backend = this.ctx.backend()
    if (!backend) return
    this.pending++
    this.sequence++
    const reply: ComposerDraftAccepted = {
      type: "composerDraftAccepted",
      epoch: item.epoch,
      generation: item.generation,
      sessionID,
      messageID,
      capture: item.capture,
    }
    try {
      await this.owned(item.identity)
      if (!this.current(item.epoch, item.generation)) return
      const { entry } = await backend.clear(item.identity, item.token, `accepted:${messageID}`)
      if (!this.current(item.epoch, item.generation)) return
      this.sending.delete(messageID)
      this.ctx.post({ ...reply, entry })
    } catch (err) {
      if (this.current(item.epoch, item.generation)) {
        if (code(err) === "conflict") this.sending.delete(messageID)
        this.ctx.post({ ...reply, error: code(err) })
      }
    } finally {
      this.pending--
    }
  }
  async flush(deadline: number): Promise<() => void> {
    const epoch = this.epoch
    const generation = this.ctx.generation()
    const backend = this.ctx.backend()
    if (!epoch || !backend || this.pending || this.sending.size) refused("promotion")
    const requestID = randomUUID()
    const ack = await new Promise<ComposerDraftFlushed>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.flushes.delete(requestID)
          reject(new Error("Composer draft flush timed out"))
        },
        Math.max(0, deadline - Date.now()),
      )
      this.flushes.set(requestID, {
        resolve: (value) => {
          clearTimeout(timer)
          this.flushes.delete(requestID)
          resolve(value)
        },
        reject: (err) => {
          clearTimeout(timer)
          this.flushes.delete(requestID)
          reject(err)
        },
      })
      this.ctx.post({ type: "composerDraftFlush", requestID, epoch, generation, deadline })
    })
    const sequence = this.sequence
    if (
      !ack.committed ||
      Date.now() >= deadline ||
      !this.current(epoch, generation) ||
      this.pending ||
      this.sending.size
    )
      refused(ack.error ?? "changed")
    for (const proof of ack.entries) await this.proof(backend, proof)
    if (this.sequence !== sequence || !this.current(epoch, generation) || Date.now() >= deadline) refused("changed")
    return () => {
      if (
        this.sequence !== sequence ||
        !this.current(epoch, generation) ||
        this.pending ||
        this.sending.size ||
        Date.now() >= deadline
      )
        refused("changed")
    }
  }
  private async proof(backend: DraftBackend, proof: ComposerDraftFlushed["entries"][number]) {
    if (this.ctx.owners().find((item) => item.box === proof.identity.box)?.owner !== proof.owner) refused("scope")
    const identity = await this.ctx.scope(proof.identity)
    const { entry } = await backend.load(identity)
    if (!entry || !same(entry.token, proof.token) || entry.mutation !== proof.mutation || entry.digest !== proof.digest)
      refused("conflict")
    if (entry.content && entry.mutation.startsWith("send:")) refused("uncertain")
  }
  dispose() {
    registry++
    this.disposed = true
    panes.delete(this)
    for (const item of this.flushes.values()) item.reject(new Error("Composer view closed"))
    this.flushes.clear()
    this.sending.clear()
  }
  detach() {
    registry++
    panes.delete(this)
    this.epoch = undefined
    this.state()
  }
  /** This fences registered main composers only; it is not a profile writer drain or admission lease. */
  static async flushAll(deadline: number): Promise<() => void> {
    const revision = registry
    const checks = await Promise.all([...panes].map((pane) => pane.flush(deadline)))
    const check = () => {
      if (registry !== revision) refused("changed")
      for (const inspect of checks) inspect()
    }
    check()
    return check
  }
}
