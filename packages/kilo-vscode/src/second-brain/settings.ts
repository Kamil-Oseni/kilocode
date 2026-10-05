import type { Memento, SecretStorage } from "vscode"
import { isDeepStrictEqual } from "node:util"
import { journal } from "./journal"
import { setup } from "./setup-v2"
import { settlement, ClientV2 } from "./client-v2"
import { descriptor, receipt as checked, type Descriptor } from "./managed/descriptor"
import type { Receipt } from "./managed/owner"
import { launch as context, admission, transition, history as managedHistory, type Launch } from "./managed/restart"

export const files = ["server.py", "index.py", "notes.py", "policy.py", "admission.py"] as const
const state = "raya.secondBrain.setup"
const debt = "raya.secondBrain.control.uncertainty"

export type Setup =
  | ReturnType<typeof setup>
  | Readonly<{
      format: "raya.memory.setup"
      version: 1
      origin: string
      root: string
      source_sha256: Readonly<Record<string, string>>
    }>

function origin(input: string) {
  const url = new URL(input)
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("Memory requires a numeric loopback origin")
  return url.origin
}

export function parse(input: unknown): Setup {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid Memory setup manifest")
  const value = input as Record<string, unknown>
  if (
    Object.keys(value).sort().join() !==
    (value.version === 2
      ? "format,origin,protocol,root,source_sha256,version"
      : "format,origin,root,source_sha256,version")
  )
    throw new Error("Invalid Memory setup fields")
  if (
    value.format !== "raya.memory.setup" ||
    (value.version !== 1 && value.version !== 2) ||
    typeof value.origin !== "string"
  )
    throw new Error("Unsupported Memory setup manifest")
  const url = origin(value.origin)
  if (value.version === 2) return setup(value, url)
  if (typeof value.root !== "string" || !/^[a-z]:[/\\]/i.test(value.root) || /[\r\n]/.test(value.root))
    throw new Error("Memory requires an absolute Windows root")
  const pins = value.source_sha256
  if (!pins || typeof pins !== "object" || Array.isArray(pins)) throw new Error("Memory source pins are required")
  const rows = pins as Record<string, unknown>
  if (
    Object.keys(rows).sort().join() !== [...files].sort().join() ||
    files.some((name) => typeof rows[name] !== "string" || !/^[a-f0-9]{64}$/.test(rows[name] as string))
  )
    throw new Error("Memory requires exactly five reviewed source pins")
  return Object.freeze({
    format: "raya.memory.setup",
    version: 1,
    origin: url,
    root: value.root,
    source_sha256: Object.freeze(Object.fromEntries(files.map((name) => [name, rows[name] as string]))),
  })
}

export class BrainSettings {
  private tail = Promise.resolve()
  private leases = new WeakMap<object, { entry: ReturnType<BrainSettings["entry"]>; client: ClientV2 }>()
  private loaded = new WeakMap<object, ReturnType<BrainSettings["entry"]>>()
  private original: { metadata: ReturnType<typeof journal>; lease: object } | undefined
  private managedEntry: ReturnType<BrainSettings["entry"]> | undefined
  private readonly launches = new WeakMap<object, Launch>()
  constructor(
    private readonly storage: Pick<Memento, "get" | "update">,
    private readonly secrets: Pick<SecretStorage, "get" | "store" | "delete">,
  ) {}

  version() {
    const raw = this.storage.get<unknown>(state)
    return raw === undefined ? undefined : parse(this.entry(raw).setup).version
  }

  current(input: unknown) {
    const selected = this.loaded.get(input as object)
    if (!selected || this.pending()) return false
    const raw = this.storage.get<unknown>(state)
    return raw !== undefined && isDeepStrictEqual(this.entry(raw), selected)
  }

  async load(): Promise<{ setup: Setup; key: string; managed?: Descriptor; launch?: Launch } | undefined> {
    const raw = this.storage.get<unknown>(state)
    if (raw === undefined) return undefined
    const entry = structuredClone(this.entry(raw))
    const setup = parse(entry.setup)
    if (setup.version === 2 && this.pending())
      throw new Error("Memory v2 operation is unavailable pending original settlement")
    const prior = entry.launch as { phase: string; receipt: Receipt } | undefined
    const launch = await this.context(entry, setup)
    if (entry.launch && !launch && (!isDeepStrictEqual(entry, this.managedEntry) || prior?.phase !== "running"))
      throw new Error("Original managed launch remains retained; restarted hosts cannot adopt or replay it")
    const key = await this.secrets.get(entry.credential)
    if (!key) return undefined
    if (!isDeepStrictEqual(this.storage.get<unknown>(state), entry))
      throw new Error("Original Memory credential selection changed during load")
    if (setup.version === 2 && this.pending())
      throw new Error("Memory v2 operation is unavailable pending original settlement")
    this.loaded.set(setup, entry)
    if (launch) this.launches.set(setup, launch)
    return { setup, key, ...(entry.managed ? { managed: entry.managed } : {}), ...(launch ? { launch } : {}) }
  }

  private async context(entry: ReturnType<BrainSettings["entry"]>, setup: Setup) {
    const prior = entry.launch as { phase: string; receipt: Receipt } | undefined
    const launch =
      entry.managed?.version === 2 && prior?.phase === "closed"
        ? await context(entry.managed, setup, prior.receipt)
        : entry.managed?.version === 2 && !prior
          ? await context(entry.managed, setup)
          : undefined
    return launch
  }

  /** Original owner retains this exact selected entry; persisted references never mint cold proof. */
  managed(input: unknown) {
    const entry = this.loaded.get(input as object)
    if (!entry?.managed) throw new Error("Original loaded managed selection required")
    const cfg = entry.managed
    const launch = this.launches.get(input as object)
    const retained = { entry }
    return async (phase: "selected" | "running" | "closed" | "uncertain", receipt: Receipt, managed?: Descriptor) => {
      const proof = checked(receipt)
      await this.serial(async () => {
        const current = this.entry(this.storage.get<unknown>(state))
        if (!isDeepStrictEqual(current, retained.entry) || this.pending())
          throw new Error("Original managed setup/debt changed")
        const original = current.launch as { phase?: string; receipt: Receipt; history?: Receipt[] } | undefined
        const restart = transition(original?.phase, phase, launch, original?.receipt)
        if (restart && !managed) throw new Error("Fresh restart descriptor required")
        if (managed && phase !== "selected") throw new Error("Original restart selection required")
        const selected = managed ? await admission(cfg, launch, proof, managed) : current.managed
        if (!isDeepStrictEqual(this.entry(this.storage.get<unknown>(state)), current) || this.pending())
          throw new Error("Original managed selection changed during admission")
        const history = managedHistory(original?.history, restart ? original!.receipt : undefined)
        const next = {
          ...current,
          ...(selected ? { managed: selected } : {}),
          launch: { phase, receipt: proof, ...(history?.length ? { history } : {}) },
        }
        await this.storage.update(state, next)
        if (!isDeepStrictEqual(this.storage.get<unknown>(state), next))
          throw new Error("Original managed receipt publication changed")
        retained.entry = next
        this.managedEntry = next
      })
    }
  }

  pending() {
    const value = this.storage.get<unknown>(debt)
    return value === undefined ? undefined : journal(value)
  }

  record(value: unknown, lease?: object) {
    const metadata = value === undefined ? undefined : journal(value)
    return this.serial(async () => {
      if (lease) {
        const selected = this.leases.get(lease)
        if (
          metadata?.version !== 2 ||
          !selected ||
          !isDeepStrictEqual(this.storage.get<unknown>(state), selected.entry) ||
          this.pending() !== undefined
        )
          throw new Error("Original Memory debt publication requires an unchanged empty slot")
      }
      this.original = undefined
      await this.storage.update(debt, metadata)
      if (metadata?.version === 2 && lease && this.leases.has(lease)) this.original = { metadata, lease }
    })
  }

  selection(input: unknown, client: ClientV2) {
    const entry = input && typeof input === "object" ? this.loaded.get(input) : undefined
    if (!(client instanceof ClientV2) || !entry || !isDeepStrictEqual(this.storage.get<unknown>(state), entry))
      throw new Error("Original loaded Memory credential selection differs")
    const lease = Object.freeze({})
    this.leases.set(lease, { entry: structuredClone(entry), client })
    return lease
  }

  settle(expected: unknown, lease: object, proof: object) {
    const metadata = journal(expected)
    return this.serial(async () => {
      const selected = this.leases.get(lease)
      const entry = selected?.entry
      const same = () => entry !== undefined && isDeepStrictEqual(this.storage.get<unknown>(state), entry)
      if (
        !same() ||
        !entry ||
        !selected ||
        this.original?.lease !== lease ||
        !isDeepStrictEqual(this.original.metadata, metadata) ||
        !settlement(proof, parse(entry.setup), metadata.request, selected.client) ||
        !isDeepStrictEqual(this.pending(), metadata)
      )
        throw new Error("Original Memory setup or debt changed before settlement")
      try {
        await this.storage.update(debt, undefined)
        if (!same() || this.pending() !== undefined)
          throw new Error("Original Memory settlement changed during publication")
        this.original = undefined
      } catch (err) {
        // Keep the original serial slot until the restoration write has actually settled.
        const current = this.pending()
        if (!same() || (current !== undefined && !isDeepStrictEqual(current, metadata)))
          throw new AggregateError(
            [err, new Error("Original Memory restoration identity changed")],
            "Memory settlement failed",
          )
        await Promise.resolve()
          .then(() => this.storage.update(debt, metadata))
          .catch((cleanup: unknown) => {
            throw new AggregateError([err, cleanup], "Memory settlement and restoration failed")
          })
        throw err
      }
    })
  }

  save(input: unknown, key: string, managed?: Descriptor) {
    const setup = parse(input)
    if (!key.trim() || /[\r\n]/.test(key)) throw new Error("Invalid Memory credential")
    const selected = managed ? descriptor(managed) : undefined
    if (selected && setup.version !== 2) throw new Error("Managed Memory requires explicit v2 setup")
    return this.serial(() => this.publish(setup, key, selected))
  }

  private async publish(setup: Setup, key: string, managed?: Descriptor) {
    const previous = this.storage.get<unknown>(state)
    const prior = previous === undefined ? undefined : this.entry(previous)
    if (prior?.managed && this.pending()) throw new Error("Original managed debt must settle before replacement")
    if (prior?.launch && (prior.launch as { phase: string }).phase !== "closed")
      throw new Error("Retained original managed launch must close before replacement")
    const credential = "raya.secondBrain.key." + crypto.randomUUID()
    await this.secrets.store(credential, key)
    try {
      await this.storage.update(state, { setup, credential, ...(managed ? { managed } : {}) })
    } catch (err) {
      await Promise.resolve()
        .then(() => this.secrets.delete(credential))
        .catch((cleanup: unknown) => {
          throw new AggregateError([err, cleanup], "Memory setup and credential cleanup failed")
        })
      throw err
    }
    if (prior) await this.secrets.delete(prior.credential)
  }

  clear() {
    return this.serial(() => this.erase())
  }

  private async erase() {
    const prior = this.storage.get<unknown>(state)
    if (prior !== undefined) {
      const entry = this.entry(prior)
      if (entry.managed && this.pending()) throw new Error("Original managed debt must settle before removal")
      if (entry.launch && (entry.launch as { phase: string }).phase !== "closed")
        throw new Error("Retained original managed launch must close before removal")
    }
    await this.storage.update(state, undefined)
    if (prior !== undefined) await this.secrets.delete(this.entry(prior).credential)
  }

  private serial(body: () => Promise<void>) {
    const task = this.tail.then(body)
    this.tail = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  private entry(raw: unknown) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid saved Memory setup")
    const value = raw as Record<string, unknown>
    if (
      !["credential,setup", "credential,managed,setup", "credential,launch,managed,setup"].includes(
        Object.keys(value).sort().join(),
      ) ||
      typeof value.credential !== "string" ||
      !/^raya\.secondBrain\.key\.[a-f0-9-]{36}$/.test(value.credential)
    )
      throw new Error("Invalid saved Memory credential reference")
    const managed = value.managed === undefined ? undefined : descriptor(value.managed)
    const launch = value.launch
    if (launch !== undefined) {
      if (!managed || !launch || typeof launch !== "object" || Array.isArray(launch))
        throw new Error("Invalid saved managed launch")
      const row = launch as Record<string, unknown>
      if (
        !["phase,receipt", "history,phase,receipt"].includes(Object.keys(row).sort().join()) ||
        !["selected", "running", "closed", "uncertain"].includes(String(row.phase))
      )
        throw new Error("Invalid retained managed phase")
      checked(row.receipt)
      if (row.history !== undefined && managed.version !== 2) throw new Error("Paired managed history required")
      managedHistory(row.history)
    }
    return {
      setup: value.setup,
      credential: value.credential,
      ...(managed ? { managed } : {}),
      ...(launch === undefined ? {} : { launch }),
    }
  }
}
