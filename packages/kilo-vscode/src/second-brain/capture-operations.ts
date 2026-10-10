import path from "node:path"
import { scope, dispose } from "./managed/projection-cache"
import { opendir } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { check, document, object } from "./control/frames"
import { directory, image, normalize } from "./control/identity"
import { records } from "./capture-intake"
import { fingerprint } from "./failed-repair"
import { parse } from "./operation"
import { parse as setup } from "./settings"
import { descriptor, type Descriptor } from "./managed/descriptor"
import { successors } from "./managed/capture-lineage"
import { lineage } from "./managed/upgrade-lineage"
import { anchor, guard as anchored, inspect, inspectAncestor } from "./managed/upgrade-publish"
import type { review } from "./capture-revisions"

type Storage = Parameters<typeof inspect>[0]
type Entry = Parameters<typeof successors>[0]
type Space = { cfg: Descriptor; setup: ReturnType<typeof setup> }
type Operation = NonNullable<NonNullable<Parameters<typeof review>[3]>["operations"]>[number]

async function listing(root: string, maximum: number, guard: () => void) {
  guard()
  const held = await opendir(root)
  const names = []
  for await (const item of held) {
    guard()
    check(names.length < maximum, "Capture operation directory exceeds its allocation bound")
    names.push(item.name)
  }
  guard()
  return names.sort()
}

/** Locate finite original receipts only in freshly proven capture successor namespaces. */
export async function locate(
  storage: Storage,
  original: unknown,
  closure: unknown,
  rows: ReturnType<typeof records>,
  guard: () => void,
) {
  check(
    original &&
      typeof original === "object" &&
      "setup" in original &&
      "credential" in original &&
      typeof original.credential === "string" &&
      "managed" in original &&
      "launch" in original,
    "Original capture operation entry required",
  )
  const previous: Entry = {
    setup: structuredClone(original.setup),
    credential: original.credential,
    managed: descriptor(original.managed),
    launch: structuredClone(original.launch),
  }
  closure = structuredClone(closure)
  rows = structuredClone(rows)
  const current = structuredClone(storage.get<Entry>("raya.secondBrain.setup"))
  check(current, "Current capture operation selection required")
  const marker = structuredClone(
    storage.get<{ audit: { artifact: Descriptor["plan"] } }>("raya.secondBrain.committedCaptureRecovery.pending"),
  )
  const cache = scope()
  const prove = async () => {
    guard()
    check(isDeepStrictEqual(storage.get("raya.secondBrain.setup"), current), "Capture operation selection changed")
    const grant = marker ? await anchor(storage, marker.audit.artifact) : undefined
    guard()
    const verify = () => {
      guard()
      if (grant) anchored(storage, grant)
      check(
        isDeepStrictEqual(storage.get("raya.secondBrain.setup"), current) &&
          isDeepStrictEqual(storage.get("raya.secondBrain.committedCaptureRecovery.pending"), marker),
        "Capture operation selection changed",
      )
    }
    const spaces: Space[] = []
    const edges = []
    const audits: { key: string; value: unknown }[] = []
    const ids = new Set<string>()
    let entry = grant?.saved ?? current
    while (!isDeepStrictEqual(entry.setup, previous.setup)) {
      verify()
      check(edges.length < 32, "Capture operation source chain exceeds its bound")
      const cfg = descriptor(entry.managed)
      const folder = path.dirname(cfg.supervisor.path)
      const id = path.basename(folder).slice("raya-memory-source-upgrade-".length)
      check(
        /^[a-f0-9]{32}$/.test(id) &&
          folder === path.join(cfg.root, "raya-memory-source-upgrade-" + id) &&
          cfg.supervisor.path === path.join(folder, "supervise.py") &&
          !ids.has(id),
        "Capture operation source chain identity differs",
      )
      ids.add(id)
      const key = `raya.secondBrain.runtimeUpgrade.${id}`
      const value = structuredClone(storage.get<{ artifact: Descriptor["plan"] }>(key))
      check(value?.artifact, "Retained capture operation upgrade required")
      const edge = grant
        ? await inspectAncestor(storage, value.artifact, grant, cache)
        : await inspect(storage, value.artifact, cache)
      verify()
      check(edge.id === id && isDeepStrictEqual(storage.get(key), value), "Capture operation upgrade changed")
      const projected = await lineage(edge.next.managed, setup(entry.setup), descriptor(entry.managed), entry.launch)
      verify()
      check(
        entry.credential === previous.credential && isDeepStrictEqual(edge.next.setup, setup(entry.setup)),
        "Capture operation upgrade projection differs",
      )
      spaces.push(...projected.descriptors.map((cfg) => ({ cfg, setup: setup(entry.setup) })))
      edges.push(edge.receipt)
      audits.push({ key, value })
      entry = edge.saved
    }
    const projected = await successors(previous, entry, closure)
    verify()
    spaces.push(...projected.descriptors.map((cfg) => ({ cfg, setup: setup(previous.setup) })))
    check(spaces.length <= 33, "Capture operation namespace chain exceeds its bound")
    check(
      audits.every((row) => isDeepStrictEqual(storage.get(row.key), row.value)),
      "Capture operation upgrade changed",
    )
    const unique = new Map<string, Space>()
    for (const space of spaces) {
      const key = normalize(space.cfg.namespaces.memory.root) + ":" + fingerprint(space.setup.source_sha256)
      const existing = unique.get(key)
      check(
        !existing || fingerprint(existing.setup.source_sha256) === fingerprint(space.setup.source_sha256),
        "Capture operation namespace has multiple source owners",
      )
      unique.set(key, space)
    }
    return { spaces: [...unique.values()], audits, edges }
  }
  const collect = async () => {
    const proven = await prove()
    const refs = []
    const captures = []
    const expected = []
    check(rows.length <= 64, "Capture operation ledger exceeds its bound")
    for (const row of rows) {
      check(row.phase === "published" && row.receipt, "Published capture operation receipt required")
      const root = path.join(row.root, "System")
      await directory(root)
      guard()
      const input = await image(path.join(root, "Capture", row.id, "input.json"), 65536)
      guard()
      const manifest = await image(path.join(root, "Changes", row.id, "manifest.json"), 65536)
      guard()
      const body = document(input.raw).value
      const journal = object(document(manifest.raw).value)
      check(
        fingerprint(body) === row.receipt &&
          journal.id === row.id &&
          journal.status === "committed" &&
          Array.isArray(journal.changes) &&
          journal.changes.length <= 128,
        "Capture operation publication differs",
      )
      const result = fingerprint({
        id: row.id,
        status: "committed",
        duplicate: false,
        note_sha256: Object.fromEntries(
          journal.changes.map((item) => {
            const change = object(item)
            check(
              typeof change.path === "string" && typeof change.new_sha256 === "string",
              "Capture operation change differs",
            )
            return [change.path, change.new_sha256]
          }),
        ),
        input_sha256: row.receipt,
      })
      refs.push(
        {
          path: path.join(root, "Capture", row.id, "input.json"),
          bytes: input.raw.length,
          sha256: input.digest,
          tuple: input.tuple,
        },
        {
          path: path.join(root, "Changes", row.id, "manifest.json"),
          bytes: manifest.raw.length,
          sha256: manifest.digest,
          tuple: manifest.tuple,
        },
      )
      expected.push({ row, result, inputSHA: row.receipt })
    }
    const operations: Operation[] = []
    const originals = new Set<string>()
    for (const space of proven.spaces) {
      const root = path.join(space.cfg.namespaces.memory.root, "Requests")
      await directory(root)
      guard()
      const epochs = await listing(root, 8192, guard)
      guard()
      check(
        epochs.length <= 8192 && epochs.every((name) => /^[a-f0-9]{32}$/.test(name)),
        "Bounded capture epochs required",
      )
      for (const epoch of epochs) {
        const folder = path.join(root, epoch)
        await directory(folder)
        guard()
        const names = await listing(folder, 16384, guard)
        guard()
        check(names.length <= 16384, "Bounded capture operation namespace required")
        for (const name of names.filter((name) => /^[a-f0-9]{32}-terminal\.json$/.test(name))) {
          originals.add(normalize(path.join(folder, name)))
          check(originals.size <= 8192, "Capture operation originals exceed their bound")
          const terminal = await image(path.join(folder, name), 65536)
          guard()
          const value = object(document(terminal.raw).value)
          if (value.kind !== "capture") continue
          captures.push({
            path: path.join(folder, name),
            bytes: terminal.raw.length,
            sha256: terminal.digest,
            tuple: terminal.tuple,
          })
          if (value.operation_outcome !== "completed") continue
          const matches = expected.filter(
            ({ row, result }) =>
              result === value.result_sha256 &&
              row.release === value.selected_release_sha256 &&
              row.release === fingerprint(space.setup.source_sha256),
          )
          if (!matches.length) continue
          check(matches.length === 1, "Capture operation publication is ambiguous")
          const { row, result, inputSHA } = matches[0]
          check(typeof value.request_sha256 === "string", "Capture operation body digest required")
          const selected = {
            request: name.slice(0, 32),
            epoch,
            release: row.release,
            digest: value.request_sha256,
            kind: "capture" as const,
            protocol: "raya.memory.operation.v2" as const,
          }
          check(row.release === fingerprint(space.setup.source_sha256), "Capture operation source release differs")
          parse(terminal.raw, selected, "terminal")
          check(
            Array.isArray(value.downstream) && value.downstream.length === 0,
            "Capture operation retained downstream differs",
          )
          const pending = await image(path.join(folder, selected.request + "-pending.json"), 65536)
          guard()
          parse(pending.raw, selected, "pending")
          const pendingRef = {
            path: path.join(folder, selected.request + "-pending.json"),
            bytes: pending.raw.length,
            sha256: pending.digest,
            tuple: pending.tuple,
          }
          const terminalRef = {
            path: path.join(folder, name),
            bytes: terminal.raw.length,
            sha256: terminal.digest,
            tuple: terminal.tuple,
          }
          refs.push(pendingRef, terminalRef)
          operations.push({
            capture: row.id,
            inputSHA,
            bodySHA: selected.digest,
            resultSHA: result,
            pendingRef,
            terminalRef,
            epoch,
            release: row.release,
            source_sha256: space.setup.source_sha256,
          })
        }
      }
    }
    check(
      new Set(operations.map((op) => op.capture)).size === operations.length,
      "One exact native operation per selected published capture required",
    )
    check(isDeepStrictEqual(await prove(), proven), "Capture operation native namespace proof changed")
    for (const ref of [...refs, ...captures]) {
      const held = await image(ref.path, 65536)
      guard()
      check(
        held.raw.length === ref.bytes && held.digest === ref.sha256 && held.tuple === ref.tuple,
        "Capture operation retained image changed",
      )
    }
    guard()
    return { operations, refs, captures, proven }
  }
  try {
    const observed = await collect()
    const fresh = async () => {
      guard()
      check(isDeepStrictEqual(await collect(), observed), "Capture operation history changed")
      guard()
    }
    await fresh()
    return { operations: observed.operations, fresh, dispose: () => dispose(cache) }
  } catch (err) {
    dispose(cache)
    throw err
  }
}
