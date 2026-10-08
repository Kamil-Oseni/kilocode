import type { Memento, SecretStorage } from "vscode"
import { isDeepStrictEqual } from "node:util"
import { journal } from "./journal"
import { setup } from "./setup-v2"
import { settlement, ClientV2 } from "./client-v2"
import { descriptor, receipt as checked, type Descriptor } from "./managed/descriptor"
import type { Receipt } from "./managed/owner"
import { launch as context, admission, transition, history as managedHistory, type Launch } from "./managed/restart"
import { review as repair } from "./failed-repair"
import { review as archive, absent } from "./failed-archive"
import { normalize } from "./control/identity"
import { review as closed, ClosedRequired } from "./closed-recovery"

export const files = ["server.py", "index.py", "notes.py", "policy.py", "admission.py"] as const
const state = "raya.secondBrain.setup"
const debt = "raya.secondBrain.control.uncertainty"
const quarantine = "raya.secondBrain.quarantinedSetups"

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
  private reopening?: Promise<void>
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
    if (entry.launch && !launch && (!isDeepStrictEqual(entry, this.managedEntry) || prior?.phase !== "running")) {
      if (entry.managed?.version === 2 && prior?.phase === "running") {
        await this.reopen(entry)
        return this.load()
      }
      throw new Error("Original managed launch remains retained; restarted hosts cannot adopt or replay it")
    }
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

  private async reopen(entry: ReturnType<BrainSettings["entry"]>) {
    // Reconcile only an exact original closure. Missing/live/uncertain owners
    // and request debt still refuse; this never adopts a running producer.
    if (!this.reopening)
      this.reopening = this.resume(async () => isDeepStrictEqual(this.storage.get<unknown>(state), entry)).finally(
        () => {
          this.reopening = undefined
        },
      )
    await this.reopening.catch((err: unknown) => {
      throw new ClosedRequired("Saved running Memory pair remains retained; verified shutdown recovery is required", {
        cause: err,
      })
    })
    if (isDeepStrictEqual(this.storage.get<unknown>(state), entry))
      throw new ClosedRequired("Original Memory setup changed before shutdown recovery")
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

  /** Restore a missed shutdown publication from the exact original producer closure. */
  resume(confirm: (value: Awaited<ReturnType<typeof closed>>) => Promise<boolean>) {
    return this.serial(async () => {
      const entry = structuredClone(this.entry(this.storage.get<unknown>(state)))
      if (this.pending()) throw new Error("Request debt requires original settlement before closed-pair recovery")
      const reviewed = await closed(entry)
      await absent(reviewed)
      if (!(await confirm(reviewed))) return
      const same = () => isDeepStrictEqual(this.storage.get<unknown>(state), entry) && this.pending() === undefined
      if (!same() || !isDeepStrictEqual(await closed(entry), reviewed)) throw new Error("Reviewed closed pair changed")
      const observation = await absent(reviewed)
      if (!same()) throw new Error("Closed-pair selection changed during absence check")
      const key = `raya.secondBrain.closedPairRecovery.${reviewed.closed.sha256}`
      if (this.storage.get(key) !== undefined) throw new Error("Closed-pair recovery audit already exists")
      const prior = entry.launch as { phase: string; receipt: Receipt; history?: Receipt[] }
      const next = { ...entry, launch: { ...prior, phase: "closed", receipt: reviewed.closed } }
      const audit = {
        format: "raya.memory.closed-pair.recovery",
        version: 1,
        previous: entry,
        review: reviewed,
        absence: observation,
        observed: Date.now(),
        phase: "prepared",
        requestSettlement: false,
      }
      await this.storage.update(key, audit)
      if (!same() || !isDeepStrictEqual(this.storage.get(key), audit)) throw new Error("Closed-pair audit changed")
      try {
        if (!isDeepStrictEqual(await closed(entry), reviewed) || !same()) throw new Error("Closed-pair inputs changed")
        await this.storage.update(state, next)
        if (!isDeepStrictEqual(this.storage.get(state), next) || this.pending())
          throw new Error("Closed-pair publication changed")
        await this.storage.update(key, { ...audit, phase: "applied" })
        if (
          !isDeepStrictEqual(this.storage.get(key), { ...audit, phase: "applied" }) ||
          !isDeepStrictEqual(this.storage.get(state), next) ||
          this.pending()
        )
          throw new Error("Closed-pair recovery changed")
        this.managedEntry = undefined
      } catch (err) {
        await this.restore(entry, next, undefined, err, key, audit)
      }
    })
  }

  /** Separately confirmed administrative metadata repair, never original-client settlement. */
  repair(file: string, confirm: (value: Awaited<ReturnType<typeof repair>>) => Promise<boolean>) {
    return this.serial(async () => {
      const entry = structuredClone(this.entry(this.storage.get<unknown>(state)))
      const metadata = this.pending()
      const reviewed = await repair(file, entry, metadata)
      const same = () =>
        isDeepStrictEqual(this.storage.get<unknown>(state), entry) && isDeepStrictEqual(this.pending(), metadata)
      if (!(await confirm(reviewed))) return
      const current = await repair(file, entry, metadata)
      if (!same() || !isDeepStrictEqual(current, reviewed)) throw new Error("Reviewed failed-search repair changed")
      const key = `raya.secondBrain.failedSearchRecovery.${reviewed.request}`
      const prior = entry.launch as { phase: string; receipt: Receipt; history?: Receipt[] }
      const next = { ...entry, launch: { ...prior, phase: "closed", receipt: reviewed.closed } }
      const audit = {
        format: "raya.memory.failed-search.repair",
        version: 1,
        previous: entry,
        debt: metadata,
        review: reviewed,
        repaired: Date.now(),
        phase: "prepared",
      }
      const retained = this.storage.get<typeof audit>(key)
      if (retained !== undefined) {
        if (
          !["prepared", "failed"].includes(retained.phase) ||
          !Number.isSafeInteger(retained.repaired) ||
          !isDeepStrictEqual(retained, { ...audit, repaired: retained.repaired, phase: retained.phase })
        )
          throw new Error("Original failed-search repair already exists or differs")
        audit.repaired = retained.repaired
      }
      await this.storage.update(key, audit)
      if (!same() || !isDeepStrictEqual(this.storage.get<unknown>(key), audit))
        throw new Error("Failed-search repair backup publication changed")
      try {
        if (!isDeepStrictEqual(await repair(file, entry, metadata), reviewed) || !same())
          throw new Error("Failed-search repair inputs changed after backup")
        await this.storage.update(state, next)
        if (!isDeepStrictEqual(this.storage.get<unknown>(state), next) || !isDeepStrictEqual(this.pending(), metadata))
          throw new Error("Failed-search repair selection changed during publication")
        await this.storage.update(debt, undefined)
        if (!isDeepStrictEqual(this.storage.get<unknown>(state), next) || this.pending() !== undefined)
          throw new Error("Failed-search repair changed during journal clearance")
        await this.storage.update(key, { ...audit, phase: "applied" })
        if (
          !isDeepStrictEqual(this.storage.get<unknown>(key), { ...audit, phase: "applied" }) ||
          !isDeepStrictEqual(this.storage.get<unknown>(state), next) ||
          this.pending() !== undefined
        )
          throw new Error("Failed-search repair audit changed")
        this.original = undefined
        this.managedEntry = undefined
      } catch (err) {
        await this.restore(entry, next, metadata, err, key, audit)
      }
    })
  }

  private async restore(
    entry: unknown,
    next: unknown,
    metadata: unknown,
    err: unknown,
    key: string,
    audit: object,
  ): Promise<never> {
    const saved = this.storage.get<unknown>(state)
    const pending = this.pending()
    if (
      (!isDeepStrictEqual(saved, entry) && !isDeepStrictEqual(saved, next)) ||
      (pending !== undefined && !isDeepStrictEqual(pending, metadata))
    )
      throw new AggregateError([err, new Error("Repair restoration identity changed")], "Failed-search repair failed")
    const errors: unknown[] = []
    await Promise.resolve(this.storage.update(state, entry)).catch((error: unknown) => errors.push(error))
    if (
      !isDeepStrictEqual(this.storage.get<unknown>(state), entry) ||
      (this.pending() !== undefined && !isDeepStrictEqual(this.pending(), metadata))
    )
      throw new AggregateError(
        [err, ...errors, new Error("Repair restoration identity changed")],
        "Failed-search repair failed",
      )
    await Promise.resolve(this.storage.update(debt, metadata)).catch((error: unknown) => errors.push(error))
    if (errors.length) throw new AggregateError([err, ...errors], "Failed-search repair restoration failed")
    if (!isDeepStrictEqual(this.pending(), metadata))
      throw new AggregateError([err, new Error("Repair journal restoration changed")], "Failed-search repair failed")
    const retained = this.storage.get<unknown>(key)
    if (!isDeepStrictEqual(retained, audit) && !isDeepStrictEqual(retained, { ...audit, phase: "applied" }))
      throw new AggregateError(
        [err, new Error("Repair audit restoration identity changed")],
        "Failed-search repair failed",
      )
    await Promise.resolve(this.storage.update(key, { ...audit, phase: "failed" })).catch((error: unknown) => {
      throw new AggregateError([err, error], "Failed-search repair audit restoration failed")
    })
    throw err
  }

  /** Explicit replacement keeps historical uncertainty in its audit; no cold settlement is minted. */
  archive(file: string, confirm: (value: Awaited<ReturnType<typeof archive>>) => Promise<boolean>) {
    return this.serial(async () => {
      const entry = structuredClone(this.entry(this.storage.get<unknown>(state)))
      const metadata = this.pending()
      const reviewed = await archive(file, entry, metadata)
      this.reusable(reviewed.setup, reviewed.managed)
      await absent(reviewed)
      const same = () =>
        isDeepStrictEqual(this.storage.get<unknown>(state), entry) && isDeepStrictEqual(this.pending(), metadata)
      if (!(await confirm(reviewed))) return
      if (!same() || !isDeepStrictEqual(await archive(file, entry, metadata), reviewed))
        throw new Error("Reviewed fresh-start selection changed")
      const key = `raya.secondBrain.failedSearchArchive.${reviewed.request}`
      const next = { setup: reviewed.setup, managed: reviewed.managed, credential: entry.credential }
      const audit = {
        format: "raya.memory.failed-search.archive",
        version: 1,
        previous: entry,
        ...(metadata === undefined ? {} : { debt: metadata }),
        review: reviewed,
        phase: "prepared",
        closure: "unproven",
        settlement: false,
      }
      const existing = this.storage.get<typeof audit>(key)
      if (
        existing !== undefined &&
        (!["prepared", "failed"].includes(existing.phase) ||
          !isDeepStrictEqual(existing, { ...audit, phase: existing.phase }))
      )
        throw new Error("Historical failure archive already exists or differs")
      await this.storage.update(key, audit)
      if (!same() || !isDeepStrictEqual(this.storage.get<unknown>(key), audit))
        throw new Error("Historical failure backup changed")
      const prior = this.quarantined()
      const retained = prior.some((value) => isDeepStrictEqual(value, entry)) ? prior : [...prior, entry]
      await this.storage.update(quarantine, retained)
      if (!same() || !isDeepStrictEqual(this.quarantined(), retained))
        throw new Error("Historical quarantine publication changed")
      try {
        if (!isDeepStrictEqual(await archive(file, entry, metadata), reviewed) || !same())
          throw new Error("Fresh-start inputs changed after backup")
        await this.activate(entry, next, metadata, key, audit, reviewed, retained)
        this.original = undefined
        this.managedEntry = undefined
      } catch (err) {
        const current = this.storage.get<Record<string, unknown>>(key)
        if (
          current?.phase === "applied" &&
          isDeepStrictEqual(current, { ...audit, phase: "applied", absence: current.absence })
        )
          await this.storage.update(key, audit)
        await this.restore(entry, next, metadata, err, key, audit)
      }
    })
  }

  private async activate(
    entry: unknown,
    next: unknown,
    metadata: unknown,
    key: string,
    audit: object,
    reviewed: Awaited<ReturnType<typeof archive>>,
    retained: unknown,
  ) {
    const absence = await absent(reviewed)
    this.reusable(reviewed.setup, reviewed.managed)
    if (!isDeepStrictEqual(this.storage.get<unknown>(state), entry) || !isDeepStrictEqual(this.pending(), metadata))
      throw new Error("Fresh-start setup changed during admission")
    await this.storage.update(state, next)
    if (!isDeepStrictEqual(this.storage.get<unknown>(state), next) || !isDeepStrictEqual(this.pending(), metadata))
      throw new Error("Fresh-start setup publication changed")
    await this.storage.update(debt, undefined)
    if (!isDeepStrictEqual(this.storage.get<unknown>(state), next) || this.pending() !== undefined)
      throw new Error("Fresh-start active journal changed")
    await this.storage.update(key, { ...audit, phase: "applied", absence })
    if (
      !isDeepStrictEqual(this.storage.get<unknown>(key), { ...audit, phase: "applied", absence }) ||
      !isDeepStrictEqual(this.storage.get<unknown>(state), next) ||
      this.pending() !== undefined ||
      !isDeepStrictEqual(this.quarantined(), retained)
    )
      throw new Error("Historical failure archive changed")
  }

  private quarantined() {
    const raw = this.storage.get<unknown>(quarantine)
    if (raw === undefined) return []
    if (!Array.isArray(raw) || raw.length > 128) throw new Error("Invalid historical Memory quarantine")
    return raw.map((value) => this.entry(value))
  }

  private reusable(setup: Setup, managed?: Descriptor) {
    for (const prior of this.quarantined()) {
      if (parse(prior.setup).origin === setup.origin) throw new Error("Quarantined Memory address cannot be reused")
      if (!managed || !prior.managed) continue
      for (const old of Object.values(prior.managed.namespaces)) {
        for (const fresh of Object.values(managed.namespaces)) {
          const a = normalize(old.root)
          const b = normalize(fresh.root)
          if (a === b || a.startsWith(b + "/") || b.startsWith(a + "/"))
            throw new Error("Quarantined Memory namespace cannot be reused")
        }
      }
    }
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
    this.reusable(setup, managed)
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
    if (prior && !this.quarantined().some((value) => value.credential === prior.credential))
      await this.secrets.delete(prior.credential)
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
    if (prior !== undefined && !this.quarantined().some((value) => value.credential === this.entry(prior).credential))
      await this.secrets.delete(this.entry(prior).credential)
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
