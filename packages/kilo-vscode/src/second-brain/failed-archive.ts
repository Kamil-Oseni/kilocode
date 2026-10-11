import path from "node:path"
import { lstat, readdir } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { check, document, object } from "./control/frames"
import { directory, image, normalize, powershell, environment } from "./control/identity"
import { command } from "./control/command"
import { inspect, fingerprint } from "./failed-repair"
import { descriptor, receipt, selection } from "./managed/descriptor"
import { parse } from "./settings"
import { parse as value } from "./managed/value"
import { inspect as completed } from "./completed-archive"
import { release } from "./control/catalog-capture"
import { current } from "./managed/catalog"
import { inspect as conflict, absent as partial, snapshot } from "./generation-conflict"

async function retained(input: unknown) {
  const ref = receipt(input)
  await directory(path.dirname(ref.path))
  const file = await image(ref.path, 65536)
  check(
    file.raw.length === ref.bytes && file.digest === ref.sha256 && file.tuple === ref.tuple,
    "Archived original image changed",
  )
  return object(document(file.raw, 65536).value)
}

function disjoint(a: string, b: string) {
  const left = normalize(a)
  const right = normalize(b)
  return left !== right && !left.startsWith(right + "/") && !right.startsWith(left + "/")
}

async function originals(
  old: Pick<Awaited<ReturnType<typeof inspect>>, "original" | "cfg"> & {
    identities?: { pid: number; parent: number }[]
  },
) {
  if (old.identities) return old.identities.flatMap((item) => [item.pid, item.parent])
  const original = await retained(old.original)
  check(
    original.format === "raya.memory.managed.pair.originals" && original.version === 2,
    "Exact historical original pair required",
  )
  const pair = object(original.originals)
  check(Object.keys(pair).sort().join() === "memory,retrieval", "Historical paired identities required")
  const pids: number[] = []
  for (const kind of ["memory", "retrieval"] as const) {
    const ref = receipt(pair[kind])
    check(
      normalize(ref.path) === normalize(path.join(path.dirname(old.original.path), `managed-${kind}-original.json`)),
      "Historical original location differs",
    )
    const producer = await retained(ref)
    check(
      producer.format === "raya.memory.managed.pair.original" &&
        producer.version === 2 &&
        producer.kind === kind &&
        isDeepStrictEqual(producer.selected, original.selected) &&
        producer.nativeFamilyRetirement === false,
      "Historical producer identity differs",
    )
    const identity = object(producer.identity)
    check(
      Number.isSafeInteger(identity.pid) &&
        Number(identity.pid) > 0 &&
        Number.isSafeInteger(identity.parent) &&
        Number(identity.parent) > 0 &&
        typeof identity.birth === "string" &&
        /^\d{1,20}$/.test(identity.birth) &&
        identity.digest === old.cfg.python.sha256 &&
        typeof identity.executable === "string" &&
        normalize(identity.executable) === normalize(old.cfg.python.path),
      "Historical process selection differs",
    )
    pids.push(Number(identity.pid))
  }
  return pids
}

async function unclosed(entry: unknown, pending: unknown, witness: ReturnType<typeof receipt>) {
  check(pending === undefined, "Unsettled request debt cannot enter missing-closure recovery")
  const saved = object(entry as Parameters<typeof object>[0])
  const setup = parse(saved.setup)
  const cfg = descriptor(saved.managed)
  const prior = object(saved.launch)
  const original = receipt(prior.receipt)
  check(
    setup.version === 2 &&
      cfg.version === 2 &&
      prior.phase === "running" &&
      isDeepStrictEqual(original, witness) &&
      path.basename(original.path) === "managed-original.json" &&
      normalize(original.path).startsWith(normalize(cfg.root) + "/"),
    "Exact saved unclosed original pair required",
  )
  const pair = await retained(original)
  check(pair.format === "raya.memory.managed.pair.originals" && pair.version === 2, "Original pair required")
  const location = path.join(path.dirname(original.path), "managed-closed.json")
  const missing = await lstat(location).then(
    () => false,
    (err: unknown) => {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return true
      throw err
    },
  )
  check(missing, "Existing closure requires exact closed-pair recovery")
  const held = await image(original.path, 65536)
  return { setup, cfg, original, held, selected: { request: original.sha256 }, outcome: "unknown" as const }
}

async function startup(entry: unknown, pending: unknown, witness: ReturnType<typeof receipt>) {
  check(pending === undefined, "Request debt cannot enter interrupted-startup recovery")
  const saved = object(entry as Parameters<typeof object>[0])
  const setup = parse(saved.setup)
  const cfg = descriptor(saved.managed)
  const prior = object(saved.launch)
  check(
    setup.version === 2 &&
      cfg.version === 2 &&
      prior.phase === "uncertain" &&
      isDeepStrictEqual(receipt(prior.receipt), witness) &&
      path.basename(witness.path) === "managed-reservation.json" &&
      normalize(witness.path).startsWith(normalize(cfg.root) + "/"),
    "Exact interrupted-startup reservation required",
  )
  const reservation = await retained(witness)
  const root = await lstat(cfg.root, { bigint: true })
  check(
    reservation.format === "raya.memory.managed.pair.selected" &&
      reservation.version === 2 &&
      isDeepStrictEqual(descriptor(reservation.descriptor), cfg) &&
      isDeepStrictEqual(reservation.rootIdentity, [root.dev, root.ino, root.birthtimeNs].map(String)),
    "Historical startup selection differs",
  )
  const identities: { ref: ReturnType<typeof receipt>; pid: number; parent: number }[] = []
  for (const kind of ["memory", "retrieval"] as const) {
    const file = path.join(path.dirname(witness.path), `managed-${kind}-original.json`)
    const exists = await lstat(file).then(
      () => true,
      (err: unknown) => {
        if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return false
        throw err
      },
    )
    if (!exists) continue
    const held = await image(file, 65536)
    const ref = receipt({ path: file, bytes: held.raw.length, sha256: held.digest, tuple: held.tuple })
    const producer = object(document(held.raw, 65536).value)
    const identity = native(producer, cfg, witness, kind)
    identities.push({ ref, pid: Number(identity.pid), parent: Number(identity.parent) })
  }
  check(identities.length > 0, "Retained startup identity required")
  const held = await image(witness.path, 65536)
  return {
    setup,
    cfg,
    original: witness,
    held,
    selected: { request: witness.sha256 },
    outcome: "unknown" as const,
    identities,
  }
}

function native(
  producer: Record<string, unknown>,
  cfg: ReturnType<typeof descriptor>,
  witness: ReturnType<typeof receipt>,
  kind: "memory" | "retrieval",
) {
  const identity = object(producer.identity as Parameters<typeof object>[0])
  check(
    producer.format === "raya.memory.managed.pair.original" &&
      producer.version === 2 &&
      producer.kind === kind &&
      isDeepStrictEqual(receipt(producer.selected), witness) &&
      producer.nativeFamilyRetirement === false &&
      Number.isSafeInteger(identity.pid) &&
      Number(identity.pid) > 0 &&
      Number.isSafeInteger(identity.parent) &&
      Number(identity.parent) > 0 &&
      typeof identity.birth === "string" &&
      /^\d{1,20}$/.test(identity.birth) &&
      identity.digest === cfg.python.sha256 &&
      typeof identity.executable === "string" &&
      normalize(identity.executable) === normalize(cfg.python.path),
    "Historical startup process selection differs",
  )
  return identity
}

async function historical(format: unknown, witness: ReturnType<typeof receipt>, entry: unknown, pending: unknown) {
  if (format === "raya.memory.closed-generation.fresh-start") {
    const saved = object(entry as Parameters<typeof object>[0])
    const prior = object(saved.launch)
    check(isDeepStrictEqual(receipt(prior.receipt), witness), "Exact saved closure required")
    return conflict(saved as { setup: unknown; managed?: unknown; launch?: unknown }, pending)
  }
  if (format === "raya.memory.interrupted-startup.fresh-start") return startup(entry, pending, witness)
  if (format === "raya.memory.completed-handoff.fresh-start") return completed(witness.path, entry, pending)
  if (format === "raya.memory.unclosed-pair.fresh-start") return unclosed(entry, pending, witness)
  return inspect(witness.path, entry, pending)
}

function completion(old: Awaited<ReturnType<typeof historical>>): old is Awaited<ReturnType<typeof completed>> {
  return old.outcome === "completed" && "terminal" in old && "closed" in old && "downstream" in old
}

function metadata(old: Awaited<ReturnType<typeof historical>>) {
  return {
    ...("identities" in old ? { identities: old.identities } : {}),
    ...(unfinished(old) ? { partial: old.partial, python: old.cfg.python.path } : {}),
  }
}

function unfinished(old: Awaited<ReturnType<typeof historical>>): old is Awaited<ReturnType<typeof conflict>> {
  return "partial" in old
}

function separate(old: Awaited<ReturnType<typeof historical>>, root: string) {
  if (unfinished(old)) check(disjoint(root, old.partial.root), "Partial generation cannot be reused")
}

/** Historical failure is quarantined, never accepted as joined or settled. */
export async function review(file: string, entry: unknown, pending: unknown) {
  await directory(path.dirname(file))
  const held = await image(file, 65536)
  const input = object(document(held.raw, 65536).value)
  check(
    Object.keys(input).sort().join() === "format,managed,observation,setup,version" &&
      [
        "raya.memory.failed-search.fresh-start",
        "raya.memory.unclosed-pair.fresh-start",
        "raya.memory.interrupted-startup.fresh-start",
        "raya.memory.completed-handoff.fresh-start",
        "raya.memory.closed-generation.fresh-start",
      ].includes(String(input.format)) &&
      input.version === 1,
    "Explicit reviewed fresh-start selection required",
  )
  const witness = receipt(input.observation)
  const old = await historical(input.format, witness, entry, pending)
  check(
    old.held.digest === witness.sha256 && old.held.raw.length === witness.bytes && old.held.tuple === witness.tuple,
    "Fresh-start observation changed",
  )
  const setup = parse(input.setup)
  const cfg = descriptor(input.managed)
  check(
    setup.version === 2 &&
      setup.protocol === old.setup.protocol &&
      setup.root === old.setup.root &&
      setup.origin !== old.setup.origin &&
      (input.format === "raya.memory.completed-handoff.fresh-start"
        ? isDeepStrictEqual(setup.source_sha256, release) && cfg.supervisor.sha256 === current
        : fingerprint(setup.source_sha256) === fingerprint(old.setup.source_sha256)),
    "Fresh setup must preserve reviewed notes/release and use a different address",
  )
  check(
    cfg.version === 2 &&
      cfg.python.sha256 === old.cfg.python.sha256 &&
      (!["raya.memory.failed-search.fresh-start", "raya.memory.closed-generation.fresh-start"].includes(
        String(input.format),
      ) ||
        cfg.supervisor.sha256 === old.cfg.supervisor.sha256),
    "Reviewed paired fresh runtime required",
  )
  const spaces = Object.values(cfg.namespaces)
  separate(old, cfg.root)
  check(disjoint(spaces[0].root, spaces[1].root), "Separate fresh service namespaces required")
  for (const space of spaces) {
    check(
      Object.values(old.cfg.namespaces).every((prior) => disjoint(prior.root, space.root)),
      "Old operation namespace cannot be reused",
    )
    separate(old, space.root)
    for (const kind of ["Runs", "Requests"]) {
      await directory(path.join(space.root, kind))
      check((await readdir(path.join(space.root, kind))).length === 0, "Unused fresh operation namespace required")
    }
  }
  const fresh = await selection(cfg, setup)
  const pids = await originals(old)
  const prior = await image(old.cfg.plan.path, 16777216)
  check(
    prior.raw.length === old.cfg.plan.bytes && prior.digest === old.cfg.plan.sha256,
    "Historical service plan changed",
  )
  const plan = object(value(prior.raw))
  const env = object(plan.env)
  const ports = [
    Number(new URL(old.setup.origin).port),
    Number(env.RAYA_RETRIEVAL_PORT),
    Number(fresh.plan.port),
    Number(fresh.retrieval!.port),
  ]
  check(
    ports.every((port) => Number.isSafeInteger(port) && port > 0 && port <= 65535) &&
      ports.slice(2).every((port) => !ports.slice(0, 2).includes(port)),
    "Fresh service ports must differ",
  )
  return Object.freeze({
    request: old.selected.request,
    root: setup.root,
    setup,
    managed: cfg,
    selection: Object.freeze({ path: file, bytes: held.raw.length, sha256: held.digest, tuple: held.tuple }),
    observation: witness,
    pids: Object.freeze([...new Set(pids)]),
    ...metadata(old),
    ports: Object.freeze(ports),
    outcome: old.outcome,
    ...(completion(old)
      ? { terminal: old.terminal, downstream: old.downstream, original: old.original, closed: old.closed }
      : {}),
    closure: "unproven" as const,
    settlement: false as const,
    qualification:
      "Explicit quarantine and fresh namespace admission; no historical producer, native family or cold settlement authority",
  })
}

/** Current absence is only admission to new ports; it proves no historical lifecycle. */
export async function absent(
  input: Pick<Awaited<ReturnType<typeof review>>, "pids" | "ports"> & {
    partial?: Awaited<ReturnType<typeof snapshot>>
    python?: string
  },
) {
  const retained = input.partial ? await partial(input.partial, input.python ?? "") : undefined
  const script = `$ErrorActionPreference='Stop'; $pids=@(${input.pids.join(",")}); $ports=@(${input.ports.join(",")}); $processes=@(Get-CimInstance Win32_Process | Where-Object {$_.ProcessId -in $pids}); $listeners=@(Get-NetTCPConnection -State Listen | Where-Object {$_.LocalPort -in $ports}); if($processes.Count -or $listeners.Count){throw 'Historical process or selected service port remains present'}; [ordered]@{processes=0;listeners=0}|ConvertTo-Json -Compress`
  const result = await command(
    powershell(),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { env: environment(), windowsHide: true },
  )
  check(
    isDeepStrictEqual(JSON.parse(result.stdout), { processes: 0, listeners: 0 }),
    "Fresh-start absence observation refused",
  )
  if (input.partial)
    check(isDeepStrictEqual(await snapshot(input.partial.root), input.partial), "Partial generation changed")
  return Object.freeze({
    observed: Date.now(),
    pids: input.pids,
    ports: input.ports,
    helper: result.receipt,
    ...(retained ? { partial: retained } : {}),
    qualification: "Current process/listener absence only; this observation does not prove historical closure",
  })
}
