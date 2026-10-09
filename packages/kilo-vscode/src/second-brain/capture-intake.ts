import { z } from "zod"
import { createHash, randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type { SecondBrainRequest } from "@kilocode/sdk/v2/client"
import { MemoryRedact } from "@kilocode/kilo-memory/redact"
import type { BrainCapture } from "../shared/second-brain"
import type { failure } from "./capture-failure"

type Command = Extract<SecondBrainRequest["command"], { action: "capture" }>
export type CaptureBinding = Readonly<{
  root: string
  release: string
  owner: string
  generation: object
  index?: "unchecked" | "approved" | "synced" | "policy_disabled"
}>
type Turn = { project: string; sessionID: string; messageID: string; source_sha256: string }
type Storage = { get<T>(key: string): T | undefined; update(key: string, value: unknown): PromiseLike<void> }
const key = "raya.secondBrain.personalCapture"
const ledger = "raya.secondBrain.personalCapture.turns"
const diagnostics = "raya.secondBrain.personalCapture.failures"
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const text = (max: number) => z.string().min(1).max(max)
const source = z
  .object({
    user: z.object({ id: text(256), text: text(16000) }).strict(),
    assistant: z.object({ id: text(256), text: text(16000) }).strict(),
    tools: z
      .array(
        z.object({ id: text(256), name: text(256), status: z.enum(["completed", "error"]), text: text(4000) }).strict(),
      )
      .max(16),
  })
  .strict()
const command = z
  .object({
    action: z.literal("capture"),
    id: z.string().uuid(),
    grant: z.string().uuid(),
    messageID: text(256),
    observed_utc: text(80),
    source_sha256: hash,
    source,
    entries: z
      .array(
        z
          .object({
            category: z.enum(["Daily", "Preferences", "Projects", "Areas", "Commitments", "Decisions"]),
            key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
            text: text(4096),
            origin: z.enum(["user_statement", "tool_observation", "assistant_interpretation"]),
            evidence: z
              .array(
                z
                  .object({
                    id: text(256),
                    start: z.number().int().min(0).max(16000),
                    end: z.number().int().min(0).max(16000),
                  })
                  .strict(),
              )
              .min(1)
              .max(4),
          })
          .strict(),
      )
      .max(8),
  })
  .strict()
const consent = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    root: z.string().min(1).max(4096),
    release: hash,
    zone: z.string().min(1).max(255),
    model: z.string().min(1).max(512),
    authorization: z
      .object({
        source: text(4096),
        sha256: hash,
        original: z
          .object({ source: text(4096), sha256: hash })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict()
type Consent = z.infer<typeof consent>
const record = z
  .object({
    id: z.string().uuid(),
    project: z.string().min(1).max(4096),
    sessionID: z.string().min(1).max(256),
    messageID: z.string().min(1).max(256),
    source_sha256: hash,
    root: text(4096),
    release: hash,
    phase: z.enum(["reserved", "saving", "skipped", "published", "uncertain", "capacity"]),
    receipt: hash.optional(),
  })
  .strict()
const rows = z.array(record).max(10000)
const failures = z
  .array(
    z
      .object({
        id: z.string().uuid(),
        stage: z.enum(["authorization", "publication", "admission", "closure", "index", "confirmation"]),
        errors: z
          .array(z.string().regex(/^[a-z_]{1,64}$/))
          .min(1)
          .max(8),
      })
      .strict(),
  )
  .max(10000)
type Record = z.infer<typeof record>
const sha = (value: string) => createHash("sha256").update(value).digest("hex")

function identity(turn: Turn) {
  const value = sha(JSON.stringify([turn.project, turn.sessionID, turn.messageID])).slice(0, 32)
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-${((parseInt(value[16], 16) & 3) | 8).toString(16)}${value.slice(17, 20)}-${value.slice(20)}`
}

function original(command: Command, turn: Turn) {
  const date = new Date(command.observed_utc)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== command.observed_utc || date.getTime() > Date.now())
    throw new Error("Original capture completion time is invalid")
  const source = command.source
  if (
    source.assistant.id !== command.messageID ||
    source.user.text.length > 16000 ||
    source.assistant.text.length > 16000 ||
    source.tools.length > 16 ||
    source.tools.some((tool) => tool.text.length > 4000) ||
    Buffer.byteLength(JSON.stringify(source)) > 24000 ||
    sha(
      JSON.stringify([
        command.observed_utc,
        source.user.id,
        source.user.text,
        source.assistant.id,
        source.assistant.text,
        source.tools.map((tool) => [tool.id, tool.name, tool.status, tool.text]),
      ]),
    ) !== turn.source_sha256
  )
    throw new Error("Original capture source fingerprint differs")
  return date
}

function evidence(command: Command) {
  const source = command.source
  const names = new Set<string>()
  if (command.entries.length > 8) throw new Error("Capture entry bound exceeded")
  for (const entry of command.entries) {
    if (
      names.has(entry.key) ||
      MemoryRedact.has(entry.text) ||
      /(^|[-_])(password|secret|credential|token|medical|health|financial|bank)([-_]|$)/.test(entry.key)
    )
      throw new Error("Restricted or duplicate capture entry")
    names.add(entry.key)
    const sources =
      entry.origin === "user_statement"
        ? [source.user]
        : entry.origin === "assistant_interpretation"
          ? [source.assistant]
          : source.tools
    for (const span of entry.evidence) {
      const original = sources.find((row) => row.id === span.id)
      if (
        !original ||
        span.start < 0 ||
        span.start >= span.end ||
        span.end > original.text.length ||
        !original.text.slice(span.start, span.end).trim()
      )
        throw new Error("Capture evidence span differs")
    }
  }
}

/** Host-private durable intake. A model or renderer cannot create saved consent. */
export class CaptureIntake {
  private tail = Promise.resolve()
  private grants = new Map<string, { turn: Turn; binding: CaptureBinding; consent: Consent; expires: number }>()
  private active = new Set<string>()
  private listeners = new Set<() => void>()
  constructor(private readonly storage: Storage) {}

  observe(listener: () => void) {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  private changed() {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        console.warn("[Raya] Memory capture status could not be delivered")
      }
    }
  }

  /** Parses public choices; only the native activation command may publish this value. */
  reviewed(value: unknown, digest: string) {
    const cfg = consent.parse(value)
    hash.parse(digest)
    if (cfg.authorization.original) throw new Error("Select original reviewed capture choices")
    return {
      ...cfg,
      authorization: {
        source: "kilo-code.new.memory.activateReviewedCapture",
        sha256: digest,
        original: cfg.authorization,
      },
    }
  }

  snapshot(binding?: CaptureBinding): BrainCapture {
    const raw = this.storage.get(key)
    if (raw === undefined) return { status: "unavailable" }
    const cfg = consent.parse(raw)
    const saved = rows.parse(this.storage.get(ledger) ?? [])
    const selected = saved.filter((row) => row.root === cfg.root && row.release === cfg.release)
    if (selected.some((row) => this.active.has(row.id))) return { status: "saving" }
    if (selected.some((row) => row.phase === "saving" || row.phase === "uncertain")) return { status: "uncertain" }
    if (selected.some((row) => row.phase === "capacity")) return { status: "capacity", reason: "source_capacity" }
    if (saved.length >= 10000) return { status: "capacity", reason: "ledger_capacity" }
    if (
      selected.some(
        (row) =>
          row.phase === "reserved" &&
          !Array.from(this.grants.values()).some(
            (grant) => identity(grant.turn) === row.id && grant.expires > Date.now(),
          ),
      )
    )
      return { status: "uncertain" }
    if (!cfg.enabled) return { status: "paused" }
    if (!binding || cfg.root !== binding.root || cfg.release !== binding.release) return { status: "unavailable" }
    if (binding.index === "policy_disabled") return { status: "paused" }
    return { status: binding.index === "synced" ? "ready" : "unavailable" }
  }

  parse(value: unknown): Command {
    return command.parse(value)
  }

  enabled() {
    const value = this.storage.get(key)
    return value !== undefined && consent.parse(value).enabled
  }

  private serial<T>(body: () => Promise<T>): Promise<T> {
    const job = this.tail.then(body)
    this.tail = job.then(
      () => undefined,
      () => undefined,
    )
    return job
  }

  /** Called only by a trusted host setup action carrying the original human authorization. */
  save(value: unknown, binding?: CaptureBinding, check?: () => void) {
    return this.serial(async () => {
      check?.()
      const cfg = consent.parse(value)
      if (binding && (cfg.root !== binding.root || cfg.release !== binding.release))
        throw new Error("Capture consent belongs to a different reviewed Memory selection")
      new Intl.DateTimeFormat("en", { timeZone: cfg.zone }).format()
      await this.storage.update(key, cfg)
      if (!isDeepStrictEqual(this.storage.get(key), cfg)) throw new Error("Capture consent persistence failed")
      this.grants.clear()
      this.changed()
      check?.()
    })
  }

  selected(binding: CaptureBinding) {
    const cfg = this.saved(binding)
    return cfg?.enabled ? cfg : undefined
  }

  saved(binding: CaptureBinding) {
    const raw = this.storage.get(key)
    if (raw === undefined) return undefined
    const cfg = consent.parse(raw)
    if (cfg.root !== binding.root || cfg.release !== binding.release) return undefined
    return cfg
  }

  grant(turn: Turn, binding: CaptureBinding, check: () => void) {
    return this.serial(async () => {
      check()
      const cfg = this.selected(binding)
      if (!cfg || binding.index !== "synced") return undefined
      const row = record.parse({
        ...turn,
        id: identity(turn),
        root: binding.root,
        release: binding.release,
        phase: "reserved",
      })
      const saved = rows.parse(this.storage.get(ledger) ?? [])
      const id = identity(turn)
      // Retain uncertainty and exact completed IDs across reopen; never evict to permit replay.
      if (saved.some((row) => row.id === id)) return undefined
      if (saved.length >= 10000)
        throw new Error("Capture history reached its limit; automatic saving needs history management")
      const next = [...saved, row]
      await this.storage.update(ledger, next)
      if (!isDeepStrictEqual(this.storage.get(ledger), next))
        throw new Error("Original capture reservation was not saved")
      check()
      if (!isDeepStrictEqual(this.selected(binding), cfg)) throw new Error("Capture consent changed before extraction")
      for (const [id, grant] of this.grants) if (grant.expires <= Date.now()) this.grants.delete(id)
      const grant = randomUUID()
      const expires = Date.now() + 35000
      this.grants.set(grant, { turn: { ...turn }, binding, consent: cfg, expires })
      this.changed()
      return { id: grant, root: cfg.root, release: cfg.release, zone: cfg.zone, model: cfg.model, expires }
    })
  }

  private claim(turn: Turn, command: Command, binding: CaptureBinding, check: () => void) {
    const grant = this.grants.get(command.grant)
    this.grants.delete(command.grant)
    check()
    if (
      !grant ||
      grant.expires <= Date.now() ||
      !isDeepStrictEqual(grant.turn, turn) ||
      grant.binding.generation !== binding.generation ||
      grant.binding.owner !== binding.owner ||
      grant.binding.root !== binding.root ||
      grant.binding.release !== binding.release ||
      !isDeepStrictEqual(this.selected(binding), grant.consent) ||
      command.id !== identity(turn) ||
      command.messageID !== turn.messageID ||
      command.source_sha256 !== turn.source_sha256
    )
      throw new Error("Original one-use capture grant is unavailable")
    return grant
  }

  consume(turn: Turn, command: Command, binding: CaptureBinding, check: () => void) {
    const grant = this.claim(turn, command, binding, check)
    const date = original(command, turn)
    const source = command.source
    evidence(command)
    const parts = new Intl.DateTimeFormat("en", {
      timeZone: grant.consent.zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date)
    const part = (type: string) => parts.find((row) => row.type === type)!.value
    const body = {
      format: "raya.memory.capture.v3" as const,
      id: command.id,
      project: turn.project,
      session: turn.sessionID,
      message: turn.messageID,
      observed_utc: command.observed_utc,
      day: `${part("year")}-${part("month")}-${part("day")}`,
      zone: grant.consent.zone,
      source_sha256: turn.source_sha256,
      source,
      entries: command.entries,
    }
    if (Buffer.byteLength(JSON.stringify(body)) > 65536) throw new Error("Capture publication bound exceeded")
    return body
  }

  begin(turn: Turn) {
    return this.transition(turn, "saving")
  }

  /** Ends only the original in-memory activity; durable outcomes remain retained. */
  end(turn: Turn) {
    this.active.delete(identity(turn))
    this.changed()
  }

  finish(
    turn: Turn,
    phase: Exclude<Record["phase"], "reserved" | "saving">,
    receipt?: string,
    diagnostic?: ReturnType<typeof failure>,
  ) {
    return this.transition(turn, phase, receipt, diagnostic)
  }

  private transition(
    turn: Turn,
    phase: Exclude<Record["phase"], "reserved">,
    receipt?: string,
    diagnostic?: ReturnType<typeof failure>,
  ) {
    return this.serial(async () => {
      if (phase === "published" && !hash.safeParse(receipt).success)
        throw new Error("Original published capture receipt required")
      const saved = rows.parse(this.storage.get(ledger) ?? [])
      const id = identity(turn)
      const prior = saved.find((row) => row.id === id)
      if (!prior || prior.source_sha256 !== turn.source_sha256 || !["reserved", "saving"].includes(prior.phase))
        throw new Error("Original capture reservation cannot be replaced")
      if (diagnostic) {
        // Separate inert diagnostics keep the replay-fencing ledger compatible with retained older builds.
        const saved = failures.parse(this.storage.get(diagnostics) ?? [])
        const next = failures.parse([...saved.filter((row) => row.id !== id), { id, ...diagnostic }])
        await this.storage.update(diagnostics, next)
        if (!isDeepStrictEqual(this.storage.get(diagnostics), next))
          throw new Error("Capture failure diagnostic persistence failed")
      }
      const next = saved.map((row) =>
        row.id === id
          ? record.parse({
              ...row,
              phase,
              ...(receipt ? { receipt } : {}),
            })
          : row,
      )
      await this.storage.update(ledger, next)
      if (!isDeepStrictEqual(this.storage.get(ledger), next)) throw new Error("Capture outcome persistence failed")
      if (phase === "saving") this.active.add(id)
      if (phase !== "saving") this.active.delete(id)
      this.changed()
    })
  }
}

export type CapturePublication = ReturnType<CaptureIntake["consume"]>
