import { createHash } from "node:crypto"
import path from "node:path"
import type z from "zod"
import { assertWorking, inventory, lookup, type Working } from "./profile-image"
import { read } from "./profile-file"
import { namespaceID } from "./profile-secondary-schema"
import { reconciliation, voice, voiceDigest, voiceReconciliation } from "./profile-voice-reconciliation-schema"

const selector = "raya/voice/usage-reconciliation/v1.json" as const
const key = (value: string) => (process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value))
const sum = (value: string) => createHash("sha256").update(value).digest("hex")
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value)
    for (const item of Object.values(value)) freeze(item)
  }
  return value
}
const reader: unique symbol = Symbol("held-voice-reconciliation-reader")
export type VoiceReader = Readonly<{ [reader]: true }>
const readers = new WeakMap<
  object,
  { token: Working; value: z.output<typeof voice>; records: readonly z.output<typeof voiceReconciliation>[] }
>()

/** Read only the exact shipped selector in authenticated historical Global namespaces. */
export async function readVoice(token: Working): Promise<VoiceReader> {
  const image = assertWorking(token)
  const native = inventory(token)
  const states: z.output<typeof voice>["states"] = []
  const records: z.output<typeof voiceReconciliation>[] = []
  const globals = [...new Map(native.globals.map((item) => [key(item.data), item])).values()]
  if (globals.length > 256) throw new Error("Voice reconciliation Global inventory exceeds bound")
  let budget = 1_048_576
  for (const scope of globals) {
    const data = scope.data
    const storage = path.join(data, "storage")
    const source = path.join(storage, selector)
    const files = native.files.filter((file) => key(file.path) === key(source))
    if (!files.length) continue
    if (files.length !== 1) throw new Error("Voice reconciliation lacks unique native identity")
    const file = files[0]
    if (file.bytes > 16_384) continue
    const mapped = lookup(token, data)
    const scopes = image.namespaces.filter(
      (item) => key(item.original.data) === key(data) && key(item.staged.data) === key(mapped),
    )
    if (scopes.length !== 1) throw new Error("Voice reconciliation lacks exact Global mapping")
    const raw = await read(path.join(mapped, "storage", selector), budget, 16_384)
    inventory(token)
    if (Buffer.byteLength(raw.value) !== file.bytes || sum(raw.value) !== file.digest)
      throw new Error("Voice reconciliation native original bytes differ")
    const parsed = (() => {
      try {
        return JSON.parse(raw.value)
      } catch (err) {
        return undefined
      }
    })()
    const state = reconciliation.safeParse(parsed)
    if (!state.success) continue
    budget -= raw.bytes
    const namespace = key(mapped) === key(image.profile.data) ? "primary" : namespaceID(data, storage)
    states.push({ namespace, data, storage, original: raw.value, state: state.data })
    records.push({
      kind: "voice-reconciliation",
      component: "voice",
      componentDigest: "0".repeat(64),
      namespace,
      data,
      storage,
      selector,
      source: file.path,
      dev: file.dev,
      ino: file.ino,
      bytes: file.bytes,
      digest: file.digest,
      rawBytesPreserved: true,
      restoration: "inert-original-no-settlement",
      activation: "inert",
    })
  }
  const value = voice.parse({ format: "raya.voice-reconciliation-evidence", version: 1, activation: "inert", states })
  const groups = records.map((item) => voiceReconciliation.parse({ ...item, componentDigest: voiceDigest(value) }))
  inventory(token)
  const proof = Object.freeze({ [reader]: true as const })
  readers.set(proof, { token, value: freeze(value), records: freeze(groups) })
  return proof
}
export function voiceValues(token: Working, proof: VoiceReader) {
  inventory(token)
  const state = readers.get(proof)
  if (!state || state.token !== token) throw new Error("Voice reconciliation reader belongs to another image")
  return state.value.states.length ? state.value : undefined
}
export function validateVoice(
  raw: z.input<typeof voiceReconciliation>,
  input: Readonly<{ voice?: z.output<typeof voice> }>,
) {
  const entry = voiceReconciliation.parse(raw)
  const value = voice.parse(input.voice)
  if (voiceDigest(value) !== entry.componentDigest) throw new Error("Voice reconciliation component differs")
  const matches = value.states.filter(
    (item) =>
      item.namespace === entry.namespace &&
      key(item.data) === key(entry.data) &&
      key(item.storage) === key(entry.storage),
  )
  if (matches.length !== 1) throw new Error("Voice reconciliation component namespace differs")
  const item = matches[0]
  if (
    key(path.join(item.data, "storage")) !== key(item.storage) ||
    key(path.join(item.storage, selector)) !== key(entry.source)
  )
    throw new Error("Voice reconciliation physical selector differs")
  if (entry.namespace !== "primary" && entry.namespace !== namespaceID(item.data, item.storage))
    throw new Error("Voice reconciliation namespace identity differs")
  if (Buffer.byteLength(item.original) !== entry.bytes || sum(item.original) !== entry.digest)
    throw new Error("Voice reconciliation original bytes differ")
}
const brand: unique symbol = Symbol("held-voice-reconciliation-correspondence")
export type VoiceClaim = Readonly<{ [brand]: true }>
const claims = new WeakMap<object, { token: Working; records: readonly z.output<typeof voiceReconciliation>[] }>()
export function bindVoice(
  token: Working,
  proof: VoiceReader,
  input: Readonly<{ voice?: z.output<typeof voice> }>,
): VoiceClaim {
  const value = voiceValues(token, proof)
  if (JSON.stringify(value) !== JSON.stringify(input.voice))
    throw new Error("Voice reconciliation differs from actual held reader")
  const state = readers.get(proof)
  if (!state) throw new Error("Voice reconciliation reader is absent")
  for (const entry of state.records) validateVoice(entry, input)
  const claim = Object.freeze({ [brand]: true as const })
  claims.set(claim, { token, records: state.records })
  return claim
}
export function voiceGroups(token: Working, claim: VoiceClaim) {
  inventory(token)
  const state = claims.get(claim)
  if (!state || state.token !== token) throw new Error("Voice reconciliation claim belongs to another image")
  return state.records
}
