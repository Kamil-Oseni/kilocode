import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { Effect, Schema } from "effect"
import type { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Storage } from "@/storage/storage"

const UUID = Schema.String.check(
  Schema.makeFilter(
    (value) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value) && value.length === 36,
  ),
)
const Hash = Schema.String.check(Schema.makeFilter((value) => /^[a-f0-9]{64}$/.test(value) && value.length === 64))
const ID = Schema.String.check(
  Schema.makeFilter((value) => /^[a-zA-Z0-9_-]{1,200}$/.test(value) && value.trim() === value),
)
const Time = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
const Operation = Schema.Literals([
  "profile",
  "auth",
  "auth_capture",
  "upload",
  "download",
  "dialog",
  "tabs",
  "frames",
  "navigate",
  "snapshot",
  "click",
  "type",
  "select",
  "scroll",
  "screenshot",
  "evaluate",
  "smoke",
])
export const Proof = Schema.Struct({
  version: Schema.Literal(1),
  identity: UUID,
  slot: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })),
  scope: Hash,
  digest: Hash,
}).annotate({ identifier: "BrowserConfirmationProof" })
export const DispatchInput = Schema.Struct({ proof: Proof, invocation: UUID }).annotate({
  identifier: "BrowserDispatchInput",
})
export const Input = Schema.Struct({
  version: Schema.Literal(1),
  requestID: ID,
  scope: Hash,
  digest: Hash,
  sessionID: ID,
  messageID: ID,
  partID: ID,
  callID: ID,
  tool: ID,
  operation: Operation,
  at: Time,
})
export const Admission = Schema.Struct({
  version: Schema.Literal(1),
  requestID: ID,
  proof: Proof,
  sessionID: ID,
  messageID: ID,
  partID: ID,
  callID: ID,
  tool: ID,
  operation: Operation,
  at: Time,
})
export const Dispatch = Schema.Struct({
  version: Schema.Literal(1),
  identity: UUID,
  invocation: UUID,
  requestID: ID,
  at: Time,
})
export const Completion = Schema.Struct({
  version: Schema.Literal(1),
  identity: UUID,
  invocation: UUID,
  ack: UUID,
  requestID: ID,
  operation: Operation,
  outcome: Schema.Literals(["confirmed", "refused", "cancelled", "unknown"]),
  resultDigest: Schema.optional(Hash),
  startedAt: Time,
  finishedAt: Time,
})
  .check(
    Schema.makeFilter(
      (value) =>
        value.finishedAt >= value.startedAt && (value.outcome !== "confirmed" || value.resultDigest !== undefined),
    ),
  )
  .annotate({ identifier: "BrowserConfirmationCompletion" })
export const Acknowledgement = Schema.Struct({ version: Schema.Literal(1), identity: UUID, ack: UUID })
export const Status = Schema.Struct({
  version: Schema.Literal(1),
  admission: Admission,
  dispatch: Schema.optional(Dispatch),
  completion: Schema.optional(Completion),
  acknowledgement: Schema.optional(Acknowledgement),
  granted: Schema.Literal(false),
})
const Retirement = Schema.Struct({ version: Schema.Literal(1), prior: Status }).check(
  Schema.makeFilter(
    (value) =>
      !value.prior.dispatch ||
      (!!value.prior.completion && !!value.prior.acknowledgement && value.prior.completion.outcome !== "unknown"),
  ),
)

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("BrowserConfirmation.Conflict", {
  message: Schema.String,
}) {}
type Store = Pick<Storage.Interface, "read" | "create" | "remove" | "list">
type Eligible = (admission: typeof Admission.Type) => Effect.Effect<boolean, unknown>
const root = ["raya", "browser-confirmations", "v1", "slots"]
const key = (slot: number, kind: string) => [...root, String(slot), kind]
const fields = ["admission", "dispatch", "completion", "acknowledgement"] as const
const refusal = () =>
  new Conflict({ message: "Browser confirmation identity or retained state is invalid; no action was granted." })

function decode<S extends Schema.Top>(schema: S, input: unknown) {
  return Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: "error" }).pipe(Effect.mapError(refusal))
}

/** Metadata only. A receipt/read or duplicate dispatch never grants a native attempt. */
export function confirmations(storage: Store, cfg: { flock: EffectFlock.Interface; directory: string }) {
  const valid = path.isAbsolute(cfg.directory) && cfg.directory.length <= 32_768
  const locked = <A, E>(body: Effect.Effect<A, E>) =>
    valid
      ? cfg.flock.withLock(body, "raya-browser-confirmations-v1", cfg.directory).pipe(Effect.mapError(refusal))
      : Effect.fail(refusal())
  const raw = (slot: number, kind: string, inventory?: ReadonlySet<string>) =>
    inventory && !inventory.has(`${slot}/${kind}`)
      ? Effect.succeed(undefined)
      : storage
          .read<unknown>(key(slot, kind))
          .pipe(Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)))
  const inventory = Effect.gen(function* () {
    const paths = yield* storage.list(root)
    if (paths.length > 1_280) return yield* refusal()
    const found = new Set<string>()
    for (const parts of paths) {
      if (parts.length !== root.length + 2 || !root.every((part, index) => parts[index] === part))
        return yield* refusal()
      const slot = Number(parts[root.length])
      const kind = parts[root.length + 1]
      if (
        !Number.isInteger(slot) ||
        slot < 0 ||
        slot > 255 ||
        String(slot) !== parts[root.length] ||
        !kind ||
        ![...fields, "retirement"].includes(kind)
      )
        return yield* refusal()
      const id = `${slot}/${kind}`
      if (found.has(id)) return yield* refusal()
      found.add(id)
    }
    return found
  })
  const load = Effect.fn("BrowserConfirmation.load")(function* (slot: number, present?: ReadonlySet<string>) {
    const marker = yield* raw(slot, "retirement", present)
    if (marker !== undefined) {
      const saved = yield* decode(Retirement, marker)
      const prior = saved.prior
      // Validate the complete immutable retirement proof even after some old files have been removed.
      if (
        prior.admission.proof.slot !== slot ||
        (prior.dispatch &&
          (prior.dispatch.identity !== prior.admission.proof.identity ||
            prior.dispatch.requestID !== prior.admission.requestID ||
            prior.dispatch.at < prior.admission.at)) ||
        (prior.completion &&
          (!prior.dispatch ||
            prior.completion.identity !== prior.admission.proof.identity ||
            prior.completion.invocation !== prior.dispatch.invocation ||
            prior.completion.requestID !== prior.admission.requestID ||
            prior.completion.operation !== prior.admission.operation ||
            prior.completion.startedAt < prior.admission.at)) ||
        (prior.acknowledgement &&
          (!prior.completion ||
            prior.acknowledgement.identity !== prior.admission.proof.identity ||
            prior.acknowledgement.ack !== prior.completion.ack))
      )
        return yield* refusal()
      for (const field of fields) {
        const value = yield* raw(slot, field, present)
        if (value !== undefined && !isDeepStrictEqual(value, prior[field])) return yield* refusal()
      }
      // Fence the admission first: interruption can never expose an old admission without its dispatch claim.
      for (const field of fields) yield* storage.remove(key(slot, field))
      yield* storage.remove(key(slot, "retirement"))
      return undefined
    }
    const admission = yield* raw(slot, "admission", present)
    const dispatch = yield* raw(slot, "dispatch", present)
    const completion = yield* raw(slot, "completion", present)
    const acknowledgement = yield* raw(slot, "acknowledgement", present)
    if (admission === undefined) {
      if (dispatch !== undefined || completion !== undefined || acknowledgement !== undefined) return yield* refusal()
      return undefined
    }
    const item = yield* decode(Admission, admission)
    if (item.proof.slot !== slot) return yield* refusal()
    const attempt = dispatch === undefined ? undefined : yield* decode(Dispatch, dispatch)
    const result = completion === undefined ? undefined : yield* decode(Completion, completion)
    const ack = acknowledgement === undefined ? undefined : yield* decode(Acknowledgement, acknowledgement)
    if (
      attempt &&
      (attempt.identity !== item.proof.identity || attempt.requestID !== item.requestID || attempt.at < item.at)
    )
      return yield* refusal()
    if (
      result &&
      (!attempt ||
        result.identity !== item.proof.identity ||
        result.invocation !== attempt.invocation ||
        result.requestID !== item.requestID ||
        result.operation !== item.operation ||
        result.startedAt < item.at)
    )
      return yield* refusal()
    if (ack && (!result || ack.identity !== item.proof.identity || ack.ack !== result.ack)) return yield* refusal()
    return {
      version: 1 as const,
      admission: item,
      ...(attempt ? { dispatch: attempt } : {}),
      ...(result ? { completion: result } : {}),
      ...(ack ? { acknowledgement: ack } : {}),
      granted: false as const,
    }
  })
  const exact = Effect.fn("BrowserConfirmation.exact")(function* (input: typeof Proof.Type) {
    const proof = yield* decode(Proof, input)
    const value = yield* load(proof.slot)
    if (!value || !isDeepStrictEqual(value.admission.proof, proof)) return yield* refusal()
    return value
  })
  const reserve = Effect.fn("BrowserConfirmation.reserve")(function* (input: typeof Input.Type, eligible?: Eligible) {
    const value = yield* decode(Input, input)
    return yield* locked(
      Effect.gen(function* () {
        const present = yield* inventory
        const slots: Array<typeof Status.Type | undefined> = []
        for (let slot = 0; slot < 256; slot++) {
          const row = yield* load(slot, present)
          slots.push(row)
          if (!row || row.admission.requestID !== value.requestID) continue
          const prior = row.admission
          const previous = {
            version: prior.version,
            requestID: prior.requestID,
            scope: prior.proof.scope,
            digest: prior.proof.digest,
            sessionID: prior.sessionID,
            messageID: prior.messageID,
            partID: prior.partID,
            callID: prior.callID,
            tool: prior.tool,
            operation: prior.operation,
            at: prior.at,
          }
          if (!isDeepStrictEqual(previous, value)) return yield* refusal()
          return prior
        }
        // One canonical tool part may own only one native request. A retry receives a new
        // request ID, but must never turn an unknown first attempt into a second effect.
        if (
          slots.some((row) => row && row.admission.proof.scope === value.scope && row.admission.partID === value.partID)
        )
          return yield* refusal()
        let slot = slots.findIndex((row) => row === undefined)
        if (slot === -1 && eligible) {
          for (let index = 0; index < slots.length; index++) {
            const row = slots[index]
            if (!row) continue
            if (row.dispatch && (!row.completion || !row.acknowledgement || row.completion.outcome === "unknown"))
              continue
            if (!(yield* eligible(row.admission))) continue
            // The bounded marker makes interrupted collection restartable without authorizing an old attempt.
            if (!(yield* storage.create(key(index, "retirement"), { version: 1, prior: row }))) return yield* refusal()
            yield* load(index)
            slot = index
            break
          }
        }
        if (slot === -1)
          return yield* new Conflict({ message: "Browser confirmation capacity is full; no action was granted." })
        const admission = {
          version: 1 as const,
          requestID: value.requestID,
          proof: { version: 1 as const, identity: crypto.randomUUID(), slot, scope: value.scope, digest: value.digest },
          sessionID: value.sessionID,
          messageID: value.messageID,
          partID: value.partID,
          callID: value.callID,
          tool: value.tool,
          operation: value.operation,
          at: value.at,
        }
        if (!(yield* storage.create(key(slot, "admission"), admission))) return yield* refusal()
        return admission
      }),
    )
  })
  const dispatch = Effect.fn("BrowserConfirmation.dispatch")(function* (proof: typeof Proof.Type, invocation: string) {
    const id = yield* decode(UUID, invocation)
    return yield* locked(
      Effect.gen(function* () {
        const value = yield* exact(proof)
        if (value.dispatch) {
          if (value.dispatch.invocation !== id) return yield* refusal()
          return { granted: false as const, dispatch: value.dispatch }
        }
        const attempt = {
          version: 1 as const,
          identity: value.admission.proof.identity,
          invocation: id,
          requestID: value.admission.requestID,
          at: Math.max(Date.now(), value.admission.at),
        }
        if (!(yield* storage.create(key(proof.slot, "dispatch"), attempt))) return yield* refusal()
        return { granted: true as const, dispatch: attempt }
      }),
    )
  })
  const confirm = Effect.fn("BrowserConfirmation.confirm")(function* (
    proof: typeof Proof.Type,
    input: typeof Completion.Type,
  ) {
    const result = yield* decode(Completion, input)
    return yield* locked(
      Effect.gen(function* () {
        const value = yield* exact(proof)
        if (
          !value.dispatch ||
          result.identity !== proof.identity ||
          result.invocation !== value.dispatch.invocation ||
          result.requestID !== value.admission.requestID ||
          result.operation !== value.admission.operation ||
          result.startedAt < value.admission.at
        )
          return yield* refusal()
        if (value.completion) {
          if (!isDeepStrictEqual(value.completion, result)) return yield* refusal()
          return value.completion
        }
        if (!(yield* storage.create(key(proof.slot, "completion"), result))) return yield* refusal()
        return result
      }),
    )
  })
  const acknowledge = Effect.fn("BrowserConfirmation.acknowledge")(function* (
    proof: typeof Proof.Type,
    input: { ack: string },
  ) {
    const value = yield* decode(Schema.Struct({ ack: UUID }), input)
    return yield* locked(
      Effect.gen(function* () {
        const row = yield* exact(proof)
        if (!row.completion || row.completion.ack !== value.ack) return yield* refusal()
        const receipt = { version: 1 as const, identity: proof.identity, ack: value.ack }
        if (row.acknowledgement) {
          if (!isDeepStrictEqual(row.acknowledgement, receipt)) return yield* refusal()
          return row.acknowledgement
        }
        if (!(yield* storage.create(key(proof.slot, "acknowledgement"), receipt))) return yield* refusal()
        return receipt
      }),
    )
  })
  const read = (proof: typeof Proof.Type) => locked(exact(proof))
  return { reserve, dispatch, confirm, acknowledge, read }
}
