import type {
  ComposerDraftExtensionMessage,
  ComposerDraftRequest,
  ComposerDraftResult,
  ComposerDraftWebviewMessage,
  DraftCapture,
  DraftCode,
  DraftContent,
  DraftEntry,
  DraftTarget,
} from "../../../src/shared/composer-drafts-messages"
import type { ExtensionMessage, WebviewMessage } from "../types/messages"

type Transport = {
  postMessage: (message: ComposerDraftWebviewMessage) => void
  onMessage: (handler: (message: ComposerDraftExtensionMessage) => void) => () => void
}
type Seal = { revision: number; content: DraftContent; owner: string }
type Record = {
  owner?: string
  context?: string
  identity: DraftTarget
  content: DraftContent
  revision: number
  saved: number
  loaded: boolean
  entry?: DraftEntry
  error?: DraftCode
  uncertain?: { mutation: string; content: DraftContent; revision: number }
  held?: DraftCapture
  captured?: number
  seal?: Seal
  job?: Promise<void>
  moving?: boolean
  reviewed?: boolean
  reading?: number
}
type Operation = ComposerDraftRequest extends infer R
  ? R extends ComposerDraftRequest
    ? Omit<R, "requestID" | "epoch" | "generation" | "owner">
    : never
  : never

const empty = (): DraftContent => ({ text: "", comments: [], images: [], scroll: 0 })
// The host binds each box to its project; an authoritative returned project ID
// must not create a second cache record beside the pane's project-less target.
const id = (target: DraftTarget, owner?: string, context?: string) =>
  JSON.stringify([owner, owner ? undefined : context, target.box, target.key, target.sessionID, target.pendingID])
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    )
  return value
}
const same = (left: DraftContent, right: DraftContent) =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
// Model selections and other draft fields can come from Solid stores. Project
// their enumerable data before cloning because structuredClone rejects proxies.
const snapshot = (content: DraftContent) => structuredClone(canonical(content) as DraftContent)
const cutoff = (record: Record) => record.seal?.revision ?? record.revision
const contents = (record: Record) => snapshot(record.seal?.content ?? record.content)
const merged = (record: Record, local: DraftContent) => !!record.seal && !same(record.content, local)
const sendable = (record: Record): record is Record & { owner: string } =>
  !record.error && !record.held && !record.seal && !record.reading && !record.moving && !!record.owner
const committed = (
  record: Record,
  seal: Seal,
  identity: DraftTarget,
  owner?: string,
): record is Record & { entry: DraftEntry & { content: DraftContent } } =>
  record.seal === seal &&
  record.loaded &&
  !record.error &&
  !record.held &&
  !record.reading &&
  !record.moving &&
  record.owner === seal.owner &&
  record.owner === owner &&
  record.identity.key === identity.key &&
  record.saved === seal.revision &&
  !!record.entry?.content &&
  same(record.entry.content, seal.content)
const target = (entry: DraftEntry): DraftTarget => {
  return {
    key: entry.identity.key,
    box: entry.identity.box,
    sessionID: entry.identity.sessionID,
    pendingID: entry.identity.pendingID,
  }
}
async function digest(content: DraftContent) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(content)))
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** One live pane owns its request epoch; server generations fence late replies. */
export class DurableDrafts {
  readonly epoch = crypto.randomUUID()
  private generation = 0
  private connected = false
  private closed = false
  private records = new Map<string, Record>()
  private owners = new Map<string, string>()
  private contexts = new Map<string, string>()
  private listeners = new Set<() => void>()
  private requests = new Map<
    string,
    { owner: string; resolve: (result: ComposerDraftResult) => void; timer: ReturnType<typeof setTimeout> }
  >()
  private unsubscribe: () => void

  constructor(
    private transport: Transport,
    private timeout = 5000,
  ) {
    this.unsubscribe = transport.onMessage((message) => this.receive(message))
    transport.postMessage({ type: "composerDraftPane", epoch: this.epoch, active: true })
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify() {
    for (const listener of this.listeners) listener()
  }

  private record(identity: DraftTarget) {
    const owner = this.owners.get(identity.box)
    const context = this.contexts.get(identity.box)
    const key = id(identity, owner, context)
    const known = this.records.get(key)
    if (known) return known
    const record: Record = {
      owner,
      context,
      identity: { ...identity },
      content: empty(),
      revision: 0,
      saved: 0,
      loaded: false,
    }
    this.records.set(key, record)
    return record
  }

  view(identity: DraftTarget) {
    const record = this.record(identity)
    return {
      owner: record.owner,
      content: snapshot(record.content),
      loaded: record.loaded,
      stored: !!record.entry?.content,
      error: record.error,
      revision: record.revision,
    }
  }

  ready() {
    return this.connected && !this.closed
  }
  owner(box: string) {
    return this.owners.get(box)
  }
  partition(box: string) {
    return this.contexts.get(box)
  }
  context(box: string, value: string) {
    if (this.contexts.get(box) === value) return
    const known = this.contexts.has(box)
    this.contexts.set(box, value)
    if (known) this.owners.delete(box)
    this.notify()
  }

  destination(identity: DraftTarget) {
    const record = this.record(identity)
    record.reading = (record.reading ?? 0) + 1
    this.notify()
    let pending = true
    const release = () => {
      if (!pending) return false
      pending = false
      record.reading = (record.reading ?? 1) - 1
      this.notify()
      return true
    }
    return {
      identity: { ...identity },
      owner: record.owner,
      context: record.context,
      cancel: release,
      append: (image: DraftContent["images"][number], current: DraftTarget) => {
        if (!release()) return
        record.content = { ...record.content, images: [...record.content.images, { ...image }] }
        record.revision++
        this.notify()
        void this.sync(record)
        return this.record(current) === record ? snapshot(record.content) : undefined
      },
    }
  }

  async discard(identity: DraftTarget) {
    const record = this.record(identity)
    const revision = record.revision
    await this.sync(record)
    if (
      !record.loaded ||
      !record.entry ||
      record.error ||
      record.held ||
      record.seal ||
      record.reading ||
      record.moving ||
      record.revision !== revision ||
      record.saved !== revision ||
      record.owner !== this.owners.get(identity.box)
    )
      return false
    const token = record.entry.token
    record.moving = true
    const mutation = crypto.randomUUID()
    const job = (async () => {
      let reply = await this.request({ type: "composerDraftClear", identity, expected: token, mutation }, record.owner)
      if (reply.error === "timeout" || reply.error === "disconnected" || reply.error === "stale") {
        reply = await this.request({ type: "composerDraftLoad", identity }, record.owner)
        if (reply.entry?.mutation !== mutation || reply.entry.content !== null) {
          record.error = "unavailable"
          return false
        }
      }
      if (reply.error || !reply.entry || reply.entry.content !== null || reply.entry.mutation !== mutation) {
        record.error = reply.error ?? "unavailable"
        return false
      }
      record.entry = reply.entry
      record.saved = revision
      if (record.revision !== revision) return false
      record.content = empty()
      record.revision = 0
      record.saved = 0
      this.notify()
      return true
    })().finally(() => {
      record.moving = false
      if (record.job === pending) record.job = undefined
      this.notify()
      if (!record.error) void this.sync(record)
    })
    const pending = job.then(() => {})
    record.job = pending
    return job
  }

  created(pendingID: string, sessionID: string, box: string) {
    const record = [...this.records.values()].find(
      (item) =>
        item.identity.pendingID === pendingID && item.identity.box === box && item.owner === this.owners.get(box),
    )
    if (!record) return
    const next: DraftTarget = {
      box,
      key: `${box}:session:${sessionID}`,
      sessionID,
      projectID: record.identity.projectID,
    }
    this.records.set(id(next, record.owner), record)
    if (record.held) return
    const prior = this.sync(record)
    record.moving = true
    const job = prior
      .then(async () => {
        if (record.error || !record.entry?.content) {
          record.error = "promotion"
          return
        }
        const reply = await this.request(
          {
            type: "composerDraftPromote",
            from: record.identity,
            to: next,
            source: record.entry.token,
            mutation: crypto.randomUUID(),
          },
          record.owner,
        )
        if (reply.error || !reply.target) {
          record.error = "promotion"
          return
        }
        this.records.delete(id(record.identity, record.owner))
        record.identity = next
        record.entry = reply.target
      })
      .finally(() => {
        record.moving = false
        if (record.job === job) record.job = undefined
        this.notify()
        if (!record.error) void this.sync(record)
      })
    record.job = job
  }

  edit(identity: DraftTarget, content: DraftContent) {
    const record = this.record(identity)
    if (same(record.content, content)) return
    record.content = snapshot(content)
    record.revision++
    this.notify()
    void this.sync(record)
  }

  async hydrate(identity: DraftTarget) {
    const record = this.record(identity)
    await this.sync(record)
    return this.view(identity)
  }

  async list(box: string) {
    const reply = await this.request({ type: "composerDraftList", box })
    for (const entry of reply.entries ?? []) {
      const record = this.record(target(entry))
      if (record.loaded || record.revision !== 0) continue
      record.entry = entry
      record.content = snapshot(entry.content ?? empty())
      record.loaded = true
      if (entry.mutation.startsWith("send:")) record.error = "uncertain"
    }
    this.notify()
    if (reply.error && reply.error !== "uncertain") throw new Error(reply.error)
    return reply.entries ?? []
  }

  private request(operation: Operation, retained?: string): Promise<ComposerDraftResult> {
    const requestID = crypto.randomUUID()
    const generation = this.generation
    const box =
      "box" in operation ? operation.box : "identity" in operation ? operation.identity.box : operation.from.box
    const owner = retained ?? this.owners.get(box) ?? ""
    const base = {
      owner,
      requestID,
      epoch: this.epoch,
      generation,
      operation: operation.type,
      type: "composerDraftResult" as const,
    }
    if (!this.connected || this.closed) return Promise.resolve({ ...base, error: "disconnected" })
    if (!owner || owner !== this.owners.get(box)) return Promise.resolve({ ...base, error: "scope" })
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.requests.delete(requestID)
        resolve({ ...base, error: "timeout" })
      }, this.timeout)
      this.requests.set(requestID, { owner, resolve, timer })
      this.transport.postMessage({ ...operation, owner, requestID, epoch: this.epoch, generation })
    })
  }

  private async sync(record: Record): Promise<void> {
    if (record.job) return record.job
    if (
      !this.connected ||
      this.closed ||
      record.held ||
      record.moving ||
      !record.owner ||
      record.owner !== this.owners.get(record.identity.box)
    )
      return
    const job = this.persist(record).finally(() => {
      if (record.job === job) record.job = undefined
      this.notify()
    })
    record.job = job
    return job
  }

  private async exact(entry: DraftEntry | undefined, mutation: string, content: DraftContent) {
    return (
      !!entry?.content &&
      entry.mutation === mutation &&
      entry.digest === (await digest(entry.content)) &&
      same(entry.content, content)
    )
  }

  private async load(record: Record) {
    const revision = record.revision
    const reply = await this.request({ type: "composerDraftLoad", identity: record.identity }, record.owner)
    if (reply.error === "uncertain" && reply.entry?.content) {
      record.entry = reply.entry
      record.loaded = true
      record.error = "uncertain"
      if (record.revision === 0) record.content = snapshot(reply.entry.content)
      this.notify()
      return
    }
    if (reply.error) {
      record.error = reply.error
      return
    }
    const entry = reply.entry ?? undefined
    const uncertain = record.uncertain
    if (uncertain && !(await this.exact(entry, uncertain.mutation, uncertain.content))) {
      record.error = "conflict"
      return
    }
    record.entry = entry
    record.loaded = true
    record.error = undefined
    if (uncertain) {
      record.saved = uncertain.revision
      record.uncertain = undefined
    } else if (revision === 0 && record.revision === 0) record.content = snapshot(entry?.content ?? empty())
    else if (entry?.content) {
      const local = record.content
      const remote = entry.content
      record.content = {
        ...local,
        comments: [
          ...new Map([...remote.comments, ...local.comments].map((comment) => [comment.id, comment])).values(),
        ],
        images: [...new Map([...remote.images, ...local.images].map((image) => [image.id, image])).values()],
        model: local.model ?? remote.model,
        agent: local.agent ?? remote.agent,
        variant: local.variant ?? remote.variant,
      }
      if (merged(record, local)) record.error = "conflict"
    }
    this.notify()
  }

  private async persist(record: Record) {
    if (!record.loaded || record.uncertain) await this.load(record)
    if (record.error) return
    while (
      record.saved !== cutoff(record) &&
      this.connected &&
      !record.held &&
      record.owner === this.owners.get(record.identity.box)
    ) {
      const revision = cutoff(record)
      const content = contents(record)
      const mutation = crypto.randomUUID()
      const reply = await this.request(
        {
          type: "composerDraftSave",
          identity: record.identity,
          expected: record.entry?.token,
          content,
          mutation,
          reviewed: record.reviewed,
        },
        record.owner,
      )
      if (reply.error || !reply.entry) {
        record.error = reply.error ?? "unavailable"
        if (record.error === "timeout" || record.error === "disconnected" || record.error === "stale")
          record.uncertain = { mutation, content, revision }
        return
      }
      if (!(await this.exact(reply.entry, mutation, content))) {
        record.error = "unavailable"
        return
      }
      record.entry = reply.entry
      record.saved = revision
      record.error = undefined
      record.reviewed = undefined
    }
  }

  async retry(identity: DraftTarget) {
    const record = this.record(identity)
    // A known CAS conflict must not overwrite a competing draft on retry.
    if (record.error === "conflict" || record.error === "promotion" || record.error === "uncertain") return false
    record.error = undefined
    await this.sync(record)
    return !record.error && record.loaded && record.saved === record.revision
  }

  async review(identity: DraftTarget) {
    const record = this.record(identity)
    if (record.error !== "uncertain" || !record.entry?.content) return false
    record.held = undefined
    record.reviewed = true
    record.error = undefined
    record.revision++
    await this.sync(record)
    return !record.error && record.saved === record.revision
  }

  async recover(identity: DraftTarget, destination: DraftTarget) {
    const source = this.record(identity)
    if (source.error !== "conflict" && source.error !== "promotion") return false
    if (
      !destination.pendingID ||
      destination.sessionID ||
      destination.box !== identity.box ||
      id(identity, source.owner) === id(destination, source.owner)
    )
      return false
    const next = this.record(destination)
    if (next.loaded || next.revision > 0) return false
    next.content = snapshot(source.content)
    next.revision = 1
    await this.sync(next)
    if (next.error || !next.loaded || next.saved !== next.revision) return false
    const loaded = await this.request({ type: "composerDraftLoad", identity: source.identity }, source.owner)
    if (loaded.error) return false
    source.entry = loaded.entry ?? undefined
    source.content = snapshot(loaded.entry?.content ?? empty())
    source.revision = 0
    source.saved = 0
    source.error = undefined
    source.uncertain = undefined
    source.held = undefined
    this.notify()
    return true
  }

  async capture(identity: DraftTarget): Promise<DraftCapture | undefined> {
    const record = this.record(identity)
    if (!sendable(record)) return undefined
    const seal = { revision: record.revision, content: snapshot(record.content), owner: record.owner }
    record.seal = seal
    await this.sync(record)
    if (!committed(record, seal, identity, this.owners.get(identity.box))) {
      if (record.seal === seal) record.seal = undefined
      if (!record.error) void this.sync(record)
      return undefined
    }
    const capture: DraftCapture = {
      owner: seal.owner,
      epoch: this.epoch,
      generation: this.generation,
      identity: { ...identity },
      token: record.entry.token,
      mutation: record.entry.mutation,
      digest: record.entry.digest,
    }
    record.seal = undefined
    record.held = capture
    record.captured = seal.revision
    return capture
  }

  release(capture: DraftCapture) {
    const record = this.records.get(id(capture.identity, capture.owner))
    if (record?.held?.mutation !== capture.mutation) return
    record.held = undefined
    void this.sync(record)
  }

  private receive(message: ComposerDraftExtensionMessage) {
    if (message.epoch !== this.epoch) return
    if (message.type === "composerDraftState") {
      this.state(message)
      return
    }
    if (message.generation !== this.generation) return
    if (message.type === "composerDraftResult") {
      const request = this.requests.get(message.requestID)
      if (!request || request.owner !== message.owner) return
      this.requests.delete(message.requestID)
      clearTimeout(request.timer)
      request.resolve(message)
      return
    }
    if (message.type === "composerDraftPrepared") {
      this.prepared(message)
      return
    }
    if (message.type === "composerDraftAccepted") {
      this.accepted(message)
      return
    }
    if (message.type === "composerDraftFlush") void this.flush(message)
  }

  private state(message: Extract<ComposerDraftExtensionMessage, { type: "composerDraftState" }>) {
    if (this.generation !== message.generation || !message.connected) {
      for (const [requestID, request] of this.requests) {
        clearTimeout(request.timer)
        request.resolve({
          type: "composerDraftResult",
          owner: request.owner,
          requestID,
          epoch: this.epoch,
          generation: this.generation,
          operation: "composerDraftLoad",
          error: "disconnected",
        })
      }
      this.requests.clear()
    }
    this.generation = message.generation
    this.connected = message.connected
    this.owners = new Map(message.owners.map((scope) => [scope.box, scope.owner]))
    for (const [key, record] of this.records) {
      const owner = this.owners.get(record.identity.box)
      if (record.owner || !owner || record.context !== this.contexts.get(record.identity.box)) continue
      this.records.delete(key)
      record.owner = owner
      this.records.set(id(record.identity, owner), record)
    }
    this.notify()
    if (this.connected) for (const record of this.records.values()) void this.sync(record)
    return
  }

  private prepared(message: Extract<ComposerDraftExtensionMessage, { type: "composerDraftPrepared" }>) {
    const record = [...this.records.values()].find(
      (item) =>
        item.owner === message.capture.owner &&
        item.held?.mutation === message.capture.mutation &&
        item.held.digest === message.capture.digest,
    )
    if (!record) return
    const next = target(message.entry)
    const collision = this.records.get(id(next, record.owner))
    if (collision && collision !== record && collision.revision !== collision.saved) {
      record.error = "promotion"
      this.notify()
      return
    }
    record.identity = next
    record.entry = message.entry
    this.records.set(id(next, record.owner), record)
    this.notify()
    return
  }

  private accepted(message: Extract<ComposerDraftExtensionMessage, { type: "composerDraftAccepted" }>) {
    const record = [...this.records.values()].find(
      (item) =>
        item.owner === message.capture.owner &&
        item.held?.mutation === message.capture.mutation &&
        item.held.digest === message.capture.digest,
    )
    if (!record || record.held?.mutation !== message.capture.mutation) return
    record.held = undefined
    if (message.error || !message.entry) {
      record.error = message.error ?? "unavailable"
      this.notify()
      return
    }
    const next = target(message.entry)
    const collision = this.records.get(id(next, record.owner))
    if (collision && collision !== record && collision.revision !== collision.saved) {
      record.error = "promotion"
      this.notify()
      return
    }
    for (const [key, value] of this.records) if (value === record) this.records.delete(key)
    record.identity = next
    this.records.set(id(next, record.owner), record)
    const unchanged = record.revision === record.captured
    record.entry = message.entry
    if (unchanged) {
      record.content = snapshot(message.entry.content ?? empty())
      record.revision = 0
      record.saved = 0
    }
    record.error = undefined
    record.captured = undefined
    this.notify()
    void this.sync(record)
    return
  }

  private async flush(message: Extract<ComposerDraftExtensionMessage, { type: "composerDraftFlush" }>) {
    const cutoff = [...new Set(this.records.values())].map((record) => ({ record, revision: record.revision }))
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, message.deadline - Date.now()))
    })
    await Promise.race([Promise.all(cutoff.map(({ record }) => this.sync(record))), deadline])
    clearTimeout(timer)
    const error =
      Date.now() >= message.deadline
        ? "timeout"
        : !this.connected || message.generation !== this.generation
          ? "disconnected"
          : cutoff.some(({ record, revision }) => record.revision !== revision) ||
              new Set(this.records.values()).size !== cutoff.length
            ? "changed"
            : cutoff.some(
                  ({ record, revision }) =>
                    record.owner !== this.owners.get(record.identity.box) &&
                    (record.saved !== revision || record.held || record.reading || record.error),
                )
              ? "scope"
              : (cutoff.find(({ record }) => record.owner === this.owners.get(record.identity.box) && record.error)
                  ?.record.error ??
                (cutoff.some(
                  ({ record, revision }) =>
                    record.owner === this.owners.get(record.identity.box) &&
                    (!record.loaded || record.saved !== revision || record.held || record.reading),
                )
                  ? "unavailable"
                  : undefined))
    this.transport.postMessage({
      type: "composerDraftFlushed",
      requestID: message.requestID,
      epoch: this.epoch,
      generation: message.generation,
      committed: !error,
      error,
      entries: error
        ? []
        : cutoff.flatMap(({ record }) =>
            record.entry && record.owner === this.owners.get(record.identity.box)
              ? [
                  {
                    owner: record.owner!,
                    identity: record.identity,
                    token: record.entry.token,
                    mutation: record.entry.mutation,
                    digest: record.entry.digest,
                  },
                ]
              : [],
          ),
    })
  }

  dispose() {
    this.closed = true
    this.transport.postMessage({ type: "composerDraftPane", epoch: this.epoch, active: false })
    this.unsubscribe()
    for (const [requestID, request] of this.requests) {
      clearTimeout(request.timer)
      request.resolve({
        type: "composerDraftResult",
        owner: request.owner,
        requestID,
        epoch: this.epoch,
        generation: this.generation,
        operation: "composerDraftLoad",
        error: "disconnected",
      })
    }
    this.requests.clear()
    this.listeners.clear()
  }
}

type Pane = {
  postMessage: (message: WebviewMessage) => void
  onMessage: (handler: (message: ExtensionMessage) => void) => () => void
}
const panes = new WeakMap<Pane, DurableDrafts>()
export function durableDrafts(transport: Pane) {
  const known = panes.get(transport)
  if (known) return known
  const controller = new DurableDrafts({
    postMessage: transport.postMessage,
    onMessage: (handler) =>
      transport.onMessage((message) => {
        if (
          message.type === "composerDraftState" ||
          message.type === "composerDraftResult" ||
          message.type === "composerDraftFlush" ||
          message.type === "composerDraftAccepted" ||
          message.type === "composerDraftPrepared"
        )
          handler(message)
      }),
  })
  panes.set(transport, controller)
  if (typeof window !== "undefined") window.addEventListener("pagehide", () => controller.dispose(), { once: true })
  return controller
}
