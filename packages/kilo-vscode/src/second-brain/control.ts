import { Failure } from "./client"
import type { BrainService } from "./service"
import type { BrainSettings } from "./settings"

type Row = Record<string, unknown>
export type Session = {
  state(): Promise<Row>
  preview(names: string[], enabled: boolean): Promise<{ ticket: object; value: Row; namespace: unknown }>
  approve(ticket: object, before?: (metadata: unknown) => Promise<void>): Promise<Row>
  discard(ticket: object): Promise<Row>
  metadata(ticket: object): unknown
  pause(expected: string, before?: (metadata: unknown) => Promise<void>, mutation?: unknown): Promise<Row>
  close(): Promise<{ code: number | null; signal: string | null; stdout: boolean; stderr: boolean; errors: string[] }>
  snapshot(): unknown
  fence(): void
}
export type Review = Readonly<{ text: string; enabled: boolean; digest: string }>
export type ControlState = Readonly<{
  status: "unchecked" | "reviewing" | "approved" | "syncing" | "synced" | "policy_disabled" | "uncertain"
  digest?: string
  hostJoinRequired?: boolean
}>

class Cancelled extends Error {}
function row(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Memory control projection refused")
  return value as Row
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Memory policy digest refused")
  return value
}

/** Complete in-memory native review. Never persist this text or send it to the webview. */
export function projection(value: Row, namespace: unknown): Review {
  const preview = row(value.preview)
  const policy = row(preview.policy)
  const prior = row(preview.prior)
  const sources = preview.sources
  if (!Array.isArray(sources) || !Array.isArray(prior.files) || typeof policy.enabled !== "boolean")
    throw new Error("Memory review projection refused")
  const selected = new Set(sources.map((value) => String(row(value).relative).toLowerCase()))
  const removed = prior.files.map(row).filter((value) => !selected.has(String(value.relative).toLowerCase()))
  const text = [
    "Local Memory source review",
    "This replaces the complete source allowlist. Omitted sources are removed. It does not start sync or capture.",
    `Root: ${String(policy.root)}`,
    `Enabled: ${policy.enabled}`,
    `Revision: ${String(policy.revision)}`,
    `Original enabled state: ${String(prior.enabled)}`,
    `Original revision: ${String(prior.revision)}`,
    `Original preview ID: ${String(preview.id)}`,
    `Review lifetime: ${String(value.expires_seconds)} seconds`,
    `Exclusion policy SHA-256: ${String(preview.ignore_sha256)}`,
    `Exact original namespace tuples (decimal strings): ${JSON.stringify(namespace)}`,
    `Original policy SHA-256: ${String(preview.expected_policy_sha256)}`,
    `Prospective policy SHA-256: ${digest(preview.prospective_policy_sha256)}`,
    `Preview SHA-256: ${digest(value.preview_sha256)}`,
    "Complete previous source allowlist:",
    ...prior.files.map((value) => {
      const file = row(value)
      return `${String(file.relative)} SHA-256 ${digest(file.sha256)} (${String(file.classification)}, ${String(file.review)})`
    }),
    "Removed sources:",
    ...removed.map((value) => `${String(value.relative)} SHA-256 ${digest(value.sha256)}`),
    ...(removed.length ? [] : ["None"]),
    "Complete selected source texts:",
    ...sources.map((value) => {
      const source = row(value)
      if (typeof source.text !== "string") throw new Error("Memory review text refused")
      return `\n--- ${String(source.relative)} (${String(source.bytes)} UTF-8 bytes) SHA-256 ${digest(source.sha256)} ---\n${source.text}`
    }),
  ].join("\n")
  if (Buffer.byteLength(text) > 524288) throw new Error("Memory review bound exceeded")
  return Object.freeze({ text, enabled: policy.enabled, digest: digest(preview.prospective_policy_sha256) })
}

/** Host-only owner; a renderer action can request review, never authorize publication. */
export class BrainControl {
  private epoch = 0
  private closed = false
  private pending: Promise<void> | undefined
  private owner: Session | undefined
  private signal: AbortController | undefined
  private state: ControlState = Object.freeze({ status: "unchecked" })
  private retained: unknown

  constructor(
    private readonly service: BrainService,
    private readonly settings: BrainSettings,
    private readonly open: (
      setup: NonNullable<Awaited<ReturnType<BrainSettings["load"]>>>["setup"],
    ) => Promise<Session>,
  ) {}

  snapshot() {
    if (this.settings.pending()) return { status: "uncertain" as const }
    if (this.state.status === "uncertain" && this.retained === undefined) return { status: "uncertain" as const }
    return { ...this.state }
  }

  invalidate() {
    this.epoch++
    this.signal?.abort()
    this.owner?.fence()
    if (this.state.status !== "uncertain" && !this.owner && !this.settings.pending())
      this.state = Object.freeze({ status: "unchecked" })
  }

  private check(epoch: number) {
    if (this.closed || epoch !== this.epoch) throw new Cancelled("Memory review is no longer current")
  }

  private transaction(
    body: (session: Session, check: () => void, close: () => Promise<void>) => Promise<void>,
  ): Promise<void> {
    if (this.closed || this.pending || this.owner || this.settings.pending() || this.state.status === "uncertain")
      return Promise.reject(new Failure("control_busy", "Memory control is busy or uncertain", 0))
    const epoch = this.epoch
    this.signal = new AbortController()
    const check = () => this.check(epoch)
    const cancellation: { error?: Cancelled } = {}
    const job = this.service
      .configure(
        () =>
          (async () => {
            const cfg = await this.settings.load()
            check()
            if (!cfg) throw new Failure("setup_invalid", "Memory setup required", 0)
            const session = await this.open(cfg.setup).catch((error: unknown) => {
              this.state = Object.freeze({ status: "uncertain" })
              throw error
            })
            this.owner = session
            let closure: Promise<void> | undefined
            const close = () =>
              (closure ??= session.close().then((value) => {
                if (value.code !== 0 || value.signal !== null || !value.stdout || !value.stderr || value.errors.length)
                  throw new Error("Memory control closure is incomplete")
              }))
            const result = await Promise.resolve()
              .then(() => {
                check()
                return body(session, check, close)
              })
              .then(
                () => ({ ok: true as const }),
                (error: unknown) => ({ ok: false as const, error }),
              )
            const closing = await close().then(
              () => ({ ok: true as const }),
              (error: unknown) => ({ ok: false as const, error }),
            )
            this.retained = session.snapshot()
            if (closing.ok) this.owner = undefined
            if (!result.ok || !closing.ok) {
              if (!(result.ok === false && result.error instanceof Cancelled) || !closing.ok)
                this.state = Object.freeze({ status: "uncertain" })
              if (!result.ok && !closing.ok && result.error === closing.error) throw result.error
              if (!result.ok && !closing.ok)
                throw new AggregateError([result.error, closing.error], "Memory control and closure failed")
              if (!result.ok) throw result.error
              if (!closing.ok) throw closing.error
            }
            const debt = this.settings.pending()
            if (debt && debt.version === 1)
              await this.settings.record(undefined).catch(async (error: unknown) => {
                this.state = Object.freeze({ status: "uncertain" })
                await this.settings.record(debt).catch((cleanup: unknown) => {
                  throw new AggregateError([error, cleanup], "Memory journal clearance and restoration failed")
                })
                throw error
              })
          })().catch((error: unknown) => {
            if (!(error instanceof Cancelled)) throw error
            cancellation.error = error
          }),
        // Policy review and confirmed sync share the original selected worker generation.
        false,
      )
      .then(() => {
        if (cancellation.error) throw cancellation.error
      })
      .finally(() => {
        this.pending = undefined
        this.signal = undefined
      })
    this.pending = job
    return job
  }

  review(names: string[], enabled: boolean, confirm: (review: Review) => Promise<boolean>) {
    return this.transaction(async (session, check) => {
      this.state = Object.freeze({ status: "reviewing" })
      const preview = await session.preview(names, enabled)
      check()
      const review = projection(preview.value, preview.namespace)
      const accepted = await confirm(review)
      check()
      if (!accepted) {
        await session.discard(preview.ticket)
        this.state = Object.freeze({ status: "unchecked" })
        return
      }
      const receipt = await session.approve(preview.ticket, async (request) => {
        check()
        await this.record(request)
        check()
      })
      check()
      this.state = Object.freeze({ status: "approved", digest: digest(receipt.policy_sha256) })
    })
  }

  sync(
    confirm: (review: Review) => Promise<boolean>,
    body: (expected: string, signal: AbortSignal, close: () => Promise<void>) => Promise<void>,
  ) {
    return this.transaction(async (session, check, close) => {
      const value = await session.state()
      check()
      const policy = row(value.policy)
      if (policy.enabled !== true || !Array.isArray(policy.files)) throw new Error("Enabled reviewed policy required")
      const expected = digest(value.policy_sha256)
      const text =
        `Sync only this current enabled source policy\nRoot: ${String(policy.root)}\nPolicy SHA-256: ${expected}\nRevision: ${String(policy.revision)}\n` +
        policy.files.map((value) => `${String(row(value).relative)} SHA-256 ${digest(row(value).sha256)}`).join("\n")
      if (!(await confirm(Object.freeze({ text, digest: expected, enabled: true })))) return
      check()
      this.state = Object.freeze({ status: "syncing", digest: expected })
      await body(expected, this.signal!.signal, close)
      check()
      this.state = Object.freeze({ status: "synced", digest: expected })
    })
  }

  pause(confirm: (review: Review) => Promise<boolean>) {
    return this.transaction(async (session, check) => {
      const value = await session.state()
      check()
      const policy = row(value.policy)
      if (!Array.isArray(policy.files) || !policy.files.length)
        throw new Error("A nonempty reviewed source policy is required")
      const preview = await session.preview(
        policy.files.map((value) => String(row(value).relative)),
        false,
      )
      check()
      const accepted = await confirm(projection(preview.value, preview.namespace))
      check()
      if (!accepted) {
        await session.discard(preview.ticket)
        return
      }
      const metadata = session.metadata(preview.ticket)
      const receipt = await session.pause(
        digest(value.policy_sha256),
        async (request) => {
          check()
          await this.record(request)
          check()
        },
        metadata,
      )
      check()
      this.state = Object.freeze({
        status: "policy_disabled",
        digest: digest(receipt.policy_sha256),
        hostJoinRequired: true,
      })
    })
  }

  private async record(request: unknown) {
    const cfg = await this.settings.load()
    if (!cfg) throw new Error("Memory setup required")
    await this.settings.record({ format: "raya.memory.control.uncertainty", version: 1, root: cfg.setup.root, request })
  }

  async stop() {
    this.invalidate()
    const outcome = await this.pending
      ?.catch((error: unknown) => {
        if (!(error instanceof Cancelled)) throw error
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    const closing = await this.owner
      ?.close()
      .then((value) => {
        if (value.code !== 0 || value.signal !== null || !value.stdout || !value.stderr || value.errors.length)
          throw new Error("Memory control closure remains incomplete")
        this.owner = undefined
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    if (outcome !== undefined || closing !== undefined) this.state = Object.freeze({ status: "uncertain" })
    if (outcome !== undefined && closing !== undefined)
      throw new AggregateError([outcome, closing], "Memory control retirement failures retained")
    if (outcome !== undefined) throw outcome
    if (closing !== undefined) throw closing
  }

  dispose() {
    this.closed = true
    return this.stop()
  }
}
