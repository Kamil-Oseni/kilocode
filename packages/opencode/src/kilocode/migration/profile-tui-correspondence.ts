import path from "node:path"
import { createHash } from "node:crypto"
import z from "zod"
import { tui } from "./profile-tui"
import { inventory, lookup, type Working } from "./profile-image"
import { read } from "./profile-file"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const absolute = z
  .string()
  .max(4096)
  .refine((value) => path.isAbsolute(value) && !/[\0\r\n]/.test(value))
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const key = (value: string) => (process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value))
export const tuiJSON = z
  .object({
    kind: z.literal("tui-json"),
    state: absolute,
    source: absolute,
    dev: z.string().regex(/^\d+$/),
    ino: z.string().regex(/^\d+$/),
    bytes: z
      .number()
      .int()
      .safe()
      .nonnegative()
      .max(128 * 1024),
    digest,
    componentDigest: digest,
    text: z.string().max(128 * 1024),
    activation: z.literal("inert"),
  })
  .strict()
export type TuiComponents = Readonly<{ tui?: z.output<typeof tui> }>
export function validateTui(raw: z.input<typeof tuiJSON>, input: TuiComponents) {
  const entry = tuiJSON.parse(raw)
  const value = tui.parse(input.tui)
  if (
    hash(JSON.stringify(value)) !== entry.componentDigest ||
    key(entry.source) !== key(path.join(entry.state, "kv.json"))
  )
    throw new Error("TUI component or exact physical selector differs")
  if (Buffer.byteLength(entry.text) !== entry.bytes || hash(entry.text) !== entry.digest)
    throw new Error("TUI source bytes differ")
  const selected = tui.shape.scopes.element.shape.values.parse(JSON.parse(entry.text))
  const scopes = value.scopes.filter((scope) => key(scope.state) === key(entry.state))
  if (scopes.length !== 1 || JSON.stringify(selected) !== JSON.stringify(scopes[0].values))
    throw new Error("TUI current safe preference projection differs")
}
const brand: unique symbol = Symbol("held-tui-correspondence")
export type TuiClaim = Readonly<{ [brand]: true }>
const claims = new WeakMap<object, { token: Working; entries: readonly z.output<typeof tuiJSON>[] }>()
export async function bindTui(token: Working, input: TuiComponents): Promise<TuiClaim> {
  const native = inventory(token)
  const value = input.tui ? tui.parse(input.tui) : undefined
  const entries: z.output<typeof tuiJSON>[] = []
  const seen = new Set<string>()
  for (const scope of value?.scopes ?? []) {
    if (!native.globals.some((graph) => key(graph.state) === key(scope.state)))
      throw new Error("TUI scope lacks its declared Global state role")
    const roots = native.roots.filter(
      (root) => root.kind === "json" && root.directory && !root.absent && key(root.path) === key(scope.state),
    )
    if (roots.length !== 1) throw new Error("TUI scope lacks an exact present directory root")
    const source = path.join(scope.state, "kv.json")
    const files = native.files.filter((file) => key(file.path) === key(source))
    if (files.length !== 1 || seen.has(key(source))) throw new Error("TUI source lacks unique native identity")
    const file = files[0]
    const raw = await read(path.join(lookup(token, scope.state), "kv.json"), 128 * 1024, 128 * 1024)
    const entry = tuiJSON.parse({
      dev: file.dev,
      ino: file.ino,
      bytes: file.bytes,
      digest: file.digest,
      kind: "tui-json",
      state: scope.state,
      source,
      componentDigest: hash(JSON.stringify(value)),
      text: raw.value,
      activation: "inert",
    })
    validateTui(entry, input)
    inventory(token)
    entries.push(Object.freeze(entry))
    seen.add(key(source))
  }
  const proof = Object.freeze({ [brand]: true as const })
  claims.set(proof, { token, entries: Object.freeze(entries) })
  return proof
}
export function tuiGroups(token: Working, proof: TuiClaim) {
  inventory(token)
  const state = claims.get(proof)
  if (!state || state.token !== token) throw new Error("TUI claim belongs to another held image")
  return state.entries
}
