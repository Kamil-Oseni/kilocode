import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID, createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Schema } from "effect"
import { NativeProcess } from "@opencode-ai/core/kilocode/process-host/index"
import { exited } from "@opencode-ai/core/kilocode/pty/receipts"
import type { Identity } from "@opencode-ai/core/kilocode/pty/lifecycle"

const Receipt = Schema.Struct({
  version: Schema.Literal(1),
  volume: Schema.String,
  index: Schema.String,
  digest: Schema.String,
  data: Schema.String,
})
const Journal = Schema.Struct({
  version: Schema.Literal(1),
  token: Schema.String,
  actor: Schema.Unknown,
  files: Schema.Array(Schema.Struct({ suffix: Schema.String, receipt: Schema.NullOr(Receipt) })),
  release: Receipt,
  result: Schema.Union([
    Schema.Struct({ outcome: Schema.Literal("unknown") }),
    Schema.Struct({ outcome: Schema.Literals(["confirmed", "cancelled"]), exitCode: Schema.Number }),
  ]),
})
const decode = Schema.decodeUnknownSync(Journal)
const same = isDeepStrictEqual
const suffixes = ["", ".go", ".job", ".launch", ".drained", ".running", ".exited"] as const
const names = [...suffixes, ...suffixes.filter((suffix) => suffix !== "").map((suffix) => `${suffix}.tmp`), ".json"]
const limit = 131_072

function bytes(receipt: typeof Receipt.Type, bound: number) {
  const value = Buffer.from(receipt.data, "base64")
  if (
    value.length > bound ||
    value.toString("base64") !== receipt.data ||
    !/^[a-f0-9]{64}$/.test(receipt.digest) ||
    createHash("sha256").update(value).digest("hex") !== receipt.digest
  )
    throw new Error("Terminal cleanup receipt is inconsistent")
  return value
}

function json(receipt: typeof Receipt.Type, bound: number): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes(receipt, bound)))
}

function file(control: string, suffix: string) {
  return suffix === ".json" ? control.slice(0, -".control".length) + ".json" : control + suffix
}

function parse(receipt: typeof Receipt.Type, token: string) {
  const journal = decode(json(receipt, limit), { onExcessProperty: "error" })
  if (
    journal.token !== token ||
    journal.files.length !== names.length ||
    journal.files.some((entry, index) => entry.suffix !== names[index]) ||
    (journal.result.outcome !== "unknown" &&
      (!Number.isInteger(journal.result.exitCode) ||
        journal.result.exitCode < 0 ||
        journal.result.exitCode > 0xffffffff))
  )
    throw new Error("Terminal cleanup journal is inconsistent")
  for (const entry of journal.files) if (entry.receipt) bytes(entry.receipt, entry.suffix === ".json" ? 16_384 : 4096)
  bytes(journal.release, 65_536)
  return { journal, receipt }
}

export async function read(directory: string, token: string) {
  if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error("Invalid terminal cleanup identity")
  const receipt = await NativeProcess.receipt(path.join(directory, `${token}.json`))
  return receipt ? parse(receipt, token) : undefined
}

async function move(file: string, receipt: typeof Receipt.Type, target: string) {
  await NativeProcess.move(file, receipt, target).catch(async (err: unknown) => {
    const saved = await NativeProcess.receipt(target)
    if (!saved || !same(saved, receipt) || (await NativeProcess.receipt(file))) throw err
  })
}

export async function tokens(directory: string) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const entries = await fs.opendir(directory)
  const tokens: string[] = []
  const pending: string[] = []
  let count = 0
  for await (const entry of entries) {
    if (++count > 8192 || !entry.isFile()) throw new Error("Unknown terminal cleanup journal")
    if (/^[a-f0-9-]{36}\.[a-f0-9-]{36}\.tmp$/.test(entry.name)) {
      pending.push(entry.name)
      continue
    }
    if (!/^[a-f0-9-]{36}\.json$/.test(entry.name)) throw new Error("Unknown terminal cleanup journal")
    tokens.push(entry.name.slice(0, -5))
    if (tokens.length > 4096) throw new Error("Terminal cleanup registry exceeds its limit")
  }
  for (const name of pending) {
    const token = name.slice(0, 36)
    const receipt = await NativeProcess.receipt(path.join(directory, name))
    if (!receipt) throw new Error("Terminal cleanup publication disappeared")
    parse(receipt, token)
    const previous = await read(directory, token)
    if (!previous) {
      await move(path.join(directory, name), receipt, path.join(directory, `${token}.json`))
      tokens.push(token)
      if (tokens.length > 4096) throw new Error("Terminal cleanup registry exceeds its limit")
    }
    const saved = await read(directory, token)
    if (!saved || !same(receipt, saved.receipt)) throw new Error("Terminal cleanup publication changed")
  }
  return tokens
}

export function validate(
  saved: { journal: typeof Journal.Type },
  actor: unknown,
  identity: Identity,
  reservation: unknown,
) {
  const journal = saved.journal
  const receipt = (suffix: string) => journal.files.find((entry) => entry.suffix === suffix)?.receipt
  const value = (suffix: string) => {
    const captured = receipt(suffix)
    return captured ? json(captured, suffix === ".json" ? 16_384 : 4096) : undefined
  }
  const header = { version: 1, token: journal.token, proof: "windows-job", pid: identity.pid, birth: identity.birth }
  const result = value(".exited")
  const stop = receipt("")
  if (
    !same(journal.actor, actor) ||
    !same(value(".json"), actor) ||
    !same(json(journal.release, 65_536), reservation) ||
    !same(value(".job"), { version: 2, token: journal.token, proof: "windows-job", assigned: true }) ||
    !same(value(".drained"), { version: 2, token: journal.token, proof: "windows-job", empty: true }) ||
    !same(value(".launch"), {
      ...header,
      helper: identity.helper,
      helperBirth: identity.helperBirth,
      state: "suspended",
    }) ||
    (stop && bytes(stop, 4096).toString("utf8") !== "stop") ||
    (receipt(".go") &&
      !same(value(".go"), {
        version: 1,
        token: journal.token,
        pid: identity.pid,
        birth: identity.birth,
        action: "resume",
      })) ||
    (receipt(".running") && !same(value(".running"), { ...header, state: "running" })) ||
    (result !== undefined &&
      journal.result.outcome === "unknown" &&
      !same(result, { ...header, state: "exited", outcome: "unknown" })) ||
    !same(journal.result, exited(result, journal.token, identity))
  )
    throw new Error("Terminal cleanup native correlation changed")
}

export async function prepare(input: {
  directory: string
  token: string
  control: string
  actor: unknown
  identity: Identity
  release: string
  reservation: unknown
}) {
  const pending = await tokens(input.directory)
  const previous = await read(input.directory, input.token)
  if (previous) {
    if (!same(previous.journal.actor, input.actor)) throw new Error("Terminal cleanup owner changed")
    return previous
  }
  if (pending.length >= 4096) throw new Error("Terminal cleanup registry is full")
  const files = []
  for (const suffix of names) {
    const receipt = await NativeProcess.receipt(file(input.control, suffix))
    if (receipt) bytes(receipt, suffix === ".json" ? 16_384 : 4096)
    files.push({ suffix, receipt: receipt ?? null })
  }
  const actor = files.find((entry) => entry.suffix === ".json")?.receipt
  const release = await NativeProcess.receipt(input.release)
  if (!actor || !same(json(actor, 16_384), input.actor) || !release || !same(json(release, 65_536), input.reservation))
    throw new Error("Terminal cleanup has no exact retired owner")
  const result = files.find((entry) => entry.suffix === ".exited")?.receipt
  const journal = {
    version: 1,
    token: input.token,
    actor: input.actor,
    files,
    release,
    result: exited(result ? json(result, 4096) : undefined, input.token, input.identity),
  }
  validate({ journal: decode(journal, { onExcessProperty: "error" }) }, input.actor, input.identity, input.reservation)
  const source = JSON.stringify(journal)
  if (Buffer.byteLength(source) > limit) throw new Error("Terminal cleanup journal exceeds its limit")
  await fs.mkdir(input.directory, { recursive: true, mode: 0o700 })
  const temp = path.join(input.directory, `${input.token}.${randomUUID()}.tmp`)
  const handle = await fs.open(temp, "wx", 0o600)
  try {
    await handle.writeFile(source)
    await handle.sync()
  } finally {
    await handle.close()
  }
  const captured = await NativeProcess.receipt(temp)
  if (!captured) throw new Error("Terminal cleanup publication disappeared")
  await move(temp, captured, path.join(input.directory, `${input.token}.json`))
  const saved = await read(input.directory, input.token)
  if (!saved || !same(saved.journal, journal)) throw new Error("Terminal cleanup publication changed")
  return saved
}

export async function remove(input: {
  directory: string
  control: string
  saved: NonNullable<Awaited<ReturnType<typeof read>>>
  occupancy: string
  release: string
}) {
  const saved = await read(input.directory, input.saved.journal.token)
  if (!saved || !same(saved, input.saved)) throw new Error("Terminal cleanup journal changed")
  if (await NativeProcess.receipt(input.occupancy)) throw new Error("Terminal workspace remains occupied")
  const release = await NativeProcess.receipt(input.release)
  if (release && !same(release, saved.journal.release)) throw new Error("Terminal release receipt changed")
  const current = []
  for (const entry of saved.journal.files) {
    const receipt = await NativeProcess.receipt(file(input.control, entry.suffix))
    if (receipt && (!entry.receipt || !same(receipt, entry.receipt)))
      throw new Error("Terminal cleanup artifact changed")
    current.push(receipt)
  }
  if (!release && current.some(Boolean)) throw new Error("Terminal cleanup release proof disappeared")
  for (const entry of saved.journal.files)
    if (entry.receipt) await NativeProcess.remove(file(input.control, entry.suffix), entry.receipt)
  await empty(input.control)
}

export async function empty(control: string) {
  for (const suffix of names)
    if (await NativeProcess.receipt(file(control, suffix))) throw new Error("Terminal cleanup artifact reappeared")
}

export async function forget(directory: string, saved: NonNullable<Awaited<ReturnType<typeof read>>>) {
  await NativeProcess.remove(path.join(directory, `${saved.journal.token}.json`), saved.receipt)
}
