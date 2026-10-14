import { Effect, Schema } from "effect"
import path from "node:path"
import { Storage } from "@/storage/storage"
import { MemoryConfig } from "@kilocode/kilo-memory/effect/config"
import type { CaptureSource } from "./capture-protocol"
import { decisions, extracted } from "./capture-extraction"
import { digest, entries, identity } from "./capture-source"
import { CaptureRejected } from "./capture-errors"

const hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))
const binding = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)),
  grantSHA: hash,
  project: text(4096),
  session: Schema.String.check(Schema.isPattern(/^ses_[a-zA-Z0-9_-]{1,128}$/)),
  assistant: Schema.String.check(Schema.isPattern(/^msg_[a-zA-Z0-9_-]{1,128}$/)),
  user: Schema.String.check(Schema.isPattern(/^msg_[a-zA-Z0-9_-]{1,128}$/)),
  source_sha256: hash,
  model: text(512),
})

/** Immutable preparation observation only; this never admits publication, indexing or replay. */
export const retain = Effect.fn("SecondBrain.captureDecisions")(function* <E, R>(
  input: unknown,
  value: unknown,
  source: CaptureSource,
  observed: string,
  current: Effect.Effect<{ readonly source_sha256: string } | undefined, E, R>,
  expires: number,
  acknowledgement = false,
) {
  if (!Number.isSafeInteger(expires) || expires <= 0) throw new Error("Original capture grant expiry required")
  const cfg = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(binding, { onExcessProperty: "error" })(input),
    catch: (err) => err,
  })
  if (
    !MemoryConfig.parse(cfg.model) ||
    !path.isAbsolute(cfg.project) ||
    cfg.id !== identity(cfg.project, cfg.session, cfg.assistant) ||
    cfg.user !== source.user.id ||
    cfg.assistant !== source.assistant.id ||
    cfg.source_sha256 !== digest(observed, source)
  )
    throw new Error("Original capture decision binding changed")
  const parsed = yield* Effect.try({
    try: () => entries(extracted(value, source, acknowledgement), source),
    catch: (err) => err,
  })
  const selected = yield* Effect.try({ try: () => decisions(value, source, acknowledgement), catch: (err) => err })
  const receipt = {
    format: "raya.capture.decisions",
    version: 1,
    ...cfg,
    count: parsed.length,
    decisions: selected,
    scope: "preparation_observation_only",
    publication: false,
    indexConfirmed: false,
    replay: false,
  }
  if (Buffer.byteLength(JSON.stringify(receipt), "utf8") > 16384)
    throw new Error("Capture decision receipt exceeds bound")
  const storage = yield* Storage.Service
  if (!(yield* storage.create(["raya", "capture-decisions", cfg.id], receipt)))
    throw new Error("Original capture decision receipt already exists")
  const checked = yield* current
  if (!checked || checked.source_sha256 !== cfg.source_sha256) throw new CaptureRejected("source_changed")
  if (expires <= Date.now()) throw new CaptureRejected("grant_expired")
  return parsed
})
