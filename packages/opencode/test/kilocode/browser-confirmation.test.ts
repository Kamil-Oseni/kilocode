import { expect } from "bun:test"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { confirmations, type Admission, type Completion } from "@/kilocode/browser/confirmation"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node, EffectFlock.node])),
)
const input = (id: string = randomUUID()) => ({
  version: 1 as const,
  requestID: `brr_${id}`,
  scope: "a".repeat(64),
  digest: "b".repeat(64),
  sessionID: "ses_confirmation",
  messageID: "msg_confirmation",
  partID: `prt_${id}`,
  callID: `call_${id}`,
  tool: "browser_click",
  operation: "click" as const,
  at: 100,
})
const completion = (
  admission: typeof Admission.Type,
  invocation: string,
  outcome: typeof Completion.Type.outcome = "confirmed",
) => ({
  version: 1 as const,
  identity: admission.proof.identity,
  invocation,
  ack: randomUUID(),
  requestID: admission.requestID,
  operation: admission.operation,
  outcome,
  ...(outcome === "confirmed" ? { resultDigest: "c".repeat(64) } : {}),
  startedAt: Date.now(),
  finishedAt: Date.now(),
})
const prefix = ["raya", "browser-confirmations", "v1", "slots"]
function fixture(
  body: (
    storage: Storage.Interface,
    cfg: { flock: EffectFlock.Interface; directory: string },
  ) => Effect.Effect<void, unknown>,
) {
  return Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const flock = yield* EffectFlock.Service
    yield* Effect.gen(function* () {
      yield* body(yield* Storage.Service, { flock, directory: path.join(dir, "locks") })
    }).pipe(Effect.provide(Storage.layerFromDir(path.join(dir, "storage"))))
  })
}

it.live(
  "immutable browser confirmation survives a new factory and never repeats its dispatch grant",
  () =>
    fixture((storage, cfg) =>
      Effect.gen(function* () {
        const ledger = confirmations(storage, cfg)
        const admission = yield* ledger.reserve(input())
        expect(yield* ledger.reserve(input(admission.requestID.slice(4)))).toEqual(admission)
        const invocation = randomUUID()
        const results = yield* Effect.all(
          [
            ledger.dispatch(admission.proof, invocation),
            confirmations(storage, cfg).dispatch(admission.proof, invocation),
          ],
          { concurrency: 2 },
        )
        expect(results.filter((row) => row.granted)).toHaveLength(1)
        expect(results[0].dispatch).toEqual(results[1].dispatch)
        const retry = { ...input(), partID: admission.partID, callID: admission.callID }
        expect(Exit.isFailure(yield* confirmations(storage, cfg).reserve(retry).pipe(Effect.exit))).toBe(true)
        const result = completion(admission, invocation)
        expect(yield* ledger.confirm(admission.proof, result)).toEqual(result)
        const restarted = confirmations(storage, cfg)
        expect(yield* restarted.confirm(admission.proof, result)).toEqual(result)
        expect((yield* restarted.dispatch(admission.proof, invocation)).granted).toBe(false)
        const acknowledgement = yield* restarted.acknowledge(admission.proof, { ack: result.ack })
        expect(yield* restarted.acknowledge(admission.proof, { ack: result.ack })).toEqual(acknowledgement)
        expect(yield* restarted.read(admission.proof)).toEqual({
          version: 1,
          admission,
          dispatch: results[0].dispatch,
          completion: result,
          acknowledgement,
          granted: false,
        })
      }),
    ),
  30_000,
)

it.live(
  "conditional browser cancellation and native dispatch have one durable winner",
  () =>
    fixture((storage, cfg) =>
      Effect.gen(function* () {
        const ledger = confirmations(storage, cfg)
        const admission = yield* ledger.reserve(input())
        const invocation = randomUUID()
        const results = yield* Effect.all(
          [
            ledger.cancel(admission.proof, invocation).pipe(Effect.exit),
            confirmations(storage, cfg).dispatch(admission.proof, invocation).pipe(Effect.exit),
          ],
          { concurrency: 2 },
        )
        expect(results.filter((row) => row._tag === "Success")).toHaveLength(1)
        const saved = yield* ledger.read(admission.proof)
        if (!saved.dispatch) {
          if (!saved.completion) throw new Error("Expected durable cancellation completion")
          expect(saved.completion?.outcome).toBe("cancelled")
          expect(saved.completion?.invocation).toBe(invocation)
          expect(Exit.isFailure(yield* ledger.dispatch(admission.proof, invocation).pipe(Effect.exit))).toBe(true)
          expect(yield* ledger.cancel(admission.proof, invocation)).toEqual(saved.completion)
          expect(Exit.isFailure(yield* ledger.cancel(admission.proof, randomUUID()).pipe(Effect.exit))).toBe(true)
          yield* ledger.acknowledge(admission.proof, { ack: saved.completion.ack })
          return
        }
        expect(saved.completion).toBeUndefined()
        expect(Exit.isFailure(yield* ledger.cancel(admission.proof, invocation).pipe(Effect.exit))).toBe(true)
        expect((yield* ledger.dispatch(admission.proof, invocation)).granted).toBe(false)
      }),
    ),
  30_000,
)

it.live(
  "browser confirmation refuses changed scope, invocation, timestamps and secret fields",
  () =>
    fixture((storage, cfg) =>
      Effect.gen(function* () {
        const ledger = confirmations(storage, cfg)
        const value = input()
        const admission = yield* ledger.reserve(value)
        const invocation = randomUUID()
        yield* ledger.dispatch(admission.proof, invocation)
        const result = completion(admission, invocation)
        yield* ledger.confirm(admission.proof, result)
        const requests: Array<Effect.Effect<unknown, unknown>> = [
          ledger.read({ ...admission.proof, scope: "c".repeat(64) }),
          ledger.dispatch(admission.proof, randomUUID()),
          ledger.confirm(admission.proof, { ...result, finishedAt: result.finishedAt + 1 }),
          ledger.reserve({ ...value, digest: "c".repeat(64) }),
          ledger.reserve({ ...value, partID: "prt_changed" }),
          ledger.confirm(admission.proof, { ...result, resultDigest: undefined }),
          ledger.confirm(admission.proof, { ...result, resultDigest: "d".repeat(64) }),
          ledger.confirm(admission.proof, {
            ...result,
            ...JSON.parse('{"constructor":"secret","snapshot":"private DOM","data":"image"}'),
          }),
          ledger.reserve({ ...value, ...JSON.parse('{"__proto__":"secret","text":"typed secret"}') }),
          ledger.dispatch(admission.proof, `${invocation}\n`),
          ledger.acknowledge(admission.proof, { ack: `${result.ack}\n` }),
        ]
        for (const request of requests) {
          expect(Exit.isFailure(yield* request.pipe(Effect.asVoid, Effect.exit))).toBe(true)
        }
        expect((yield* ledger.read(admission.proof)).completion).toEqual(result)
        const paths = yield* storage.list(prefix)
        const records = yield* Effect.forEach(paths, (key) => storage.read<unknown>(key))
        const json = JSON.stringify(records)
        for (const secret of ["secret", "private DOM", "image", "typed secret", "constructor", "__proto__"])
          expect(json.includes(secret)).toBe(false)
      }),
    ),
  30_000,
)

it.live(
  "malformed or orphaned browser slot records refuse before another dispatch",
  () =>
    fixture((storage, cfg) =>
      Effect.gen(function* () {
        const ledger = confirmations(storage, cfg)
        const admission = yield* ledger.reserve(input())
        yield* storage.replace([...prefix, String(admission.proof.slot), "admission"], {
          ...admission,
          secret: "not allowed",
        })
        expect(Exit.isFailure(yield* ledger.read(admission.proof).pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* ledger.dispatch(admission.proof, randomUUID()).pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* ledger.reserve(input()).pipe(Effect.exit))).toBe(true)
        expect((yield* storage.list(prefix)).some((key) => key.at(-1) === "dispatch")).toBe(false)
        yield* storage.remove([...prefix, String(admission.proof.slot), "admission"])
        yield* storage.create(
          [...prefix, String(admission.proof.slot), "completion"],
          completion(admission, randomUUID()),
        )
        expect(Exit.isFailure(yield* ledger.reserve(input()).pipe(Effect.exit))).toBe(true)
      }),
    ),
  30_000,
)

it.live(
  "interrupted browser collection resumes exact metadata cleanup without granting a stale dispatch",
  () =>
    fixture((storage, cfg) =>
      Effect.gen(function* () {
        for (const boundary of ["admission", "dispatch", "completion", "acknowledgement", "retirement"]) {
          const ledger = confirmations(storage, cfg)
          const admissions = Array.from({ length: 256 }, (_, slot) => {
            const value = input()
            return {
              version: 1 as const,
              requestID: value.requestID,
              proof: { version: 1 as const, identity: randomUUID(), slot, scope: value.scope, digest: value.digest },
              sessionID: value.sessionID,
              messageID: value.messageID,
              partID: value.partID,
              callID: value.callID,
              tool: value.tool,
              operation: value.operation,
              at: value.at,
            }
          })
          yield* Effect.forEach(
            admissions,
            (admission) => storage.create([...prefix, String(admission.proof.slot), "admission"], admission),
            { concurrency: 8 },
          )
          const admission = admissions[0]
          const invocation = randomUUID()
          yield* ledger.dispatch(admission.proof, invocation)
          const result = completion(admission, invocation)
          yield* ledger.confirm(admission.proof, result)
          yield* ledger.acknowledge(admission.proof, { ack: result.ack })
          const fault = { fired: false }
          // Every effect reaches the actual store except this single interrupted removal boundary.
          const interrupted = confirmations(
            {
              read: storage.read,
              create: storage.create,
              list: storage.list,
              remove: (key) =>
                Effect.suspend(() => {
                  if (!fault.fired && key.at(-1) === boundary) {
                    fault.fired = true
                    return Effect.die(new Error("Synthetic interrupted collection"))
                  }
                  return storage.remove(key)
                }),
            },
            cfg,
          )
          expect(
            Exit.isFailure(
              yield* interrupted.reserve(input(), (value) => Effect.succeed(value.proof.slot === 0)).pipe(Effect.exit),
            ),
          ).toBe(true)
          expect(fault.fired).toBe(true)
          expect(yield* storage.list(prefix)).toHaveLength(
            260 - ["admission", "dispatch", "completion", "acknowledgement", "retirement"].indexOf(boundary),
          )
          const restarted = confirmations(storage, cfg)
          expect(Exit.isFailure(yield* restarted.dispatch(admission.proof, invocation).pipe(Effect.exit))).toBe(true)
          const replacement = yield* restarted.reserve(input())
          expect(replacement.proof.slot).toBe(0)
          expect(replacement.proof.identity).not.toBe(admission.proof.identity)
          expect((yield* restarted.dispatch(replacement.proof, randomUUID())).granted).toBe(true)
          expect(yield* storage.list(prefix)).toHaveLength(257)
          for (const key of yield* storage.list(prefix)) yield* storage.remove(key)
        }
      }),
    ),
  180_000,
)

it.live(
  "browser retirement refuses changed slot identity and unknown outcomes without deleting evidence",
  () =>
    fixture((storage, cfg) =>
      Effect.gen(function* () {
        const ledger = confirmations(storage, cfg)
        const admission = yield* ledger.reserve(input())
        const invocation = randomUUID()
        yield* ledger.dispatch(admission.proof, invocation)
        const result = completion(admission, invocation, "unknown")
        yield* ledger.confirm(admission.proof, result)
        yield* ledger.acknowledge(admission.proof, { ack: result.ack })
        const prior = yield* ledger.read(admission.proof)
        const key = [...prefix, String(admission.proof.slot), "retirement"]
        yield* storage.create(key, { version: 1, prior })
        expect(Exit.isFailure(yield* confirmations(storage, cfg).read(admission.proof).pipe(Effect.exit))).toBe(true)
        expect(yield* storage.list(prefix)).toHaveLength(5)
        yield* storage.replace(key, {
          version: 1,
          prior: { ...prior, completion: { ...result, outcome: "confirmed", resultDigest: "c".repeat(64) } },
        })
        expect(Exit.isFailure(yield* ledger.read(admission.proof).pipe(Effect.exit))).toBe(true)
        expect(yield* storage.read([...prefix, String(admission.proof.slot), "completion"])).toEqual(result)
        expect(yield* storage.list(prefix)).toHaveLength(5)
      }),
    ),
  30_000,
)

it.live(
  "acknowledged unknown browser outcomes retain capacity and cannot be automatically collected",
  () =>
    fixture((storage, cfg) =>
      Effect.gen(function* () {
        const ledger = confirmations(storage, cfg)
        const admissions = Array.from({ length: 256 }, (_, slot) => {
          const value = input()
          return {
            version: 1 as const,
            requestID: value.requestID,
            proof: { version: 1 as const, identity: randomUUID(), slot, scope: value.scope, digest: value.digest },
            sessionID: value.sessionID,
            messageID: value.messageID,
            partID: value.partID,
            callID: value.callID,
            tool: value.tool,
            operation: value.operation,
            at: value.at,
          }
        })
        yield* Effect.forEach(
          admissions,
          (admission) => storage.create([...prefix, String(admission.proof.slot), "admission"], admission),
          { concurrency: 8 },
        )
        for (const admission of admissions) {
          const invocation = randomUUID()
          yield* ledger.dispatch(admission.proof, invocation)
          const result = completion(admission, invocation, "unknown")
          yield* ledger.confirm(admission.proof, result)
          yield* ledger.acknowledge(admission.proof, { ack: result.ack })
        }
        const calls = { value: 0 }
        expect(
          Exit.isFailure(
            yield* ledger
              .reserve(input(), () =>
                Effect.sync(() => {
                  calls.value++
                  return true
                }),
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(calls.value).toBe(0)
        expect(yield* storage.list(prefix)).toHaveLength(1024)
        expect((yield* ledger.read(admissions[0].proof)).completion?.outcome).toBe("unknown")
      }),
    ),
  180_000,
)

it.live(
  "more than 256 successful browser cycles recycle only acknowledged eligible slots and fence stale proofs",
  () =>
    fixture((storage, cfg) =>
      Effect.gen(function* () {
        const ledger = confirmations(storage, cfg)
        let first: typeof Admission.Type | undefined
        for (let index = 0; index < 260; index++) {
          const admission = yield* ledger.reserve(input(), () => Effect.succeed(true))
          if (!first) first = admission
          const invocation = randomUUID()
          const grant = yield* ledger.dispatch(admission.proof, invocation)
          expect(grant.granted).toBe(true)
          const result = completion(
            admission,
            invocation,
            index % 3 === 0 ? "refused" : index % 3 === 1 ? "cancelled" : "confirmed",
          )
          yield* ledger.confirm(admission.proof, result)
          yield* ledger.acknowledge(admission.proof, { ack: result.ack })
        }
        if (!first) throw new Error("Expected a retained first admission")
        expect(Exit.isFailure(yield* ledger.read(first.proof).pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* ledger.dispatch(first.proof, randomUUID()).pipe(Effect.exit))).toBe(true)
        expect(yield* storage.list(prefix)).toHaveLength(1024)
      }),
    ),
  300_000,
)

it.live(
  "terminal admissions without a dispatch can be collected but unacknowledged attempts cannot",
  () =>
    fixture((storage, cfg) =>
      Effect.gen(function* () {
        const ledger = confirmations(storage, cfg)
        const admissions = Array.from({ length: 256 }, (_, slot) => {
          const value = input()
          return {
            version: 1 as const,
            requestID: value.requestID,
            proof: { version: 1 as const, identity: randomUUID(), slot, scope: value.scope, digest: value.digest },
            sessionID: value.sessionID,
            messageID: value.messageID,
            partID: value.partID,
            callID: value.callID,
            tool: value.tool,
            operation: value.operation,
            at: value.at,
          }
        })
        yield* Effect.forEach(
          admissions,
          (admission) => storage.create([...prefix, String(admission.proof.slot), "admission"], admission),
          { concurrency: 8 },
        )
        const invocation = randomUUID()
        yield* ledger.dispatch(admissions[0].proof, invocation)
        yield* ledger.confirm(admissions[0].proof, completion(admissions[0], invocation))
        expect(Exit.isFailure(yield* ledger.reserve(input(), () => Effect.succeed(false)).pipe(Effect.exit))).toBe(true)
        const replacement = yield* ledger.reserve(input(), (admission) => Effect.succeed(admission.proof.slot <= 1))
        expect(replacement.proof.slot).toBe(1)
        expect((yield* ledger.read(admissions[0].proof)).acknowledgement).toBeUndefined()
        expect(Exit.isFailure(yield* ledger.dispatch(admissions[1].proof, randomUUID()).pipe(Effect.exit))).toBe(true)
      }),
    ),
  90_000,
)
