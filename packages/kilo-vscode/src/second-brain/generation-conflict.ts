import path from "node:path"
import { lstat, readdir } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { check } from "./control/frames"
import { directory, environment, image, normalize, powershell } from "./control/identity"
import { command } from "./control/command"
import { descriptor, receipt } from "./managed/descriptor"
import { launch } from "./managed/restart"
import { review as closure } from "./closed-recovery"
import { parse } from "./settings"

/** Read only: an unfinished namespace is retained, never adopted or treated as a retired producer. */
export async function snapshot(root: string) {
  await directory(root)
  const before = await lstat(root, { bigint: true })
  const tuple = (row: typeof before) => [row.dev, row.ino, row.birthtimeNs, row.mtimeNs, row.ctimeNs].map(String)
  const names = ["memory", "memory-plan.json", "retrieval", "retrieval-plan.json"]
  check(
    isDeepStrictEqual((await readdir(root)).sort(), names),
    "Unknown partial-generation artifacts require inspection",
  )
  const spaces = []
  for (const kind of ["memory", "retrieval"]) {
    const folder = path.join(root, kind)
    await directory(folder)
    const before = tuple(await lstat(folder, { bigint: true }))
    check(isDeepStrictEqual((await readdir(folder)).sort(), ["Requests", "Runs"]), "Partial namespace differs")
    for (const name of ["Requests", "Runs"]) {
      const dir = path.join(folder, name)
      await directory(dir)
      const before = tuple(await lstat(dir, { bigint: true }))
      check((await readdir(dir)).length === 0, "Partial namespace has unknown work")
      check(isDeepStrictEqual(before, tuple(await lstat(dir, { bigint: true }))), "Partial namespace changed")
      spaces.push({ path: dir, tuple: before })
    }
    check(isDeepStrictEqual(before, tuple(await lstat(folder, { bigint: true }))), "Partial namespace changed")
    spaces.push({ path: folder, tuple: before })
  }
  const files = []
  for (const name of ["memory-plan.json", "retrieval-plan.json"]) {
    const file = path.join(root, name)
    const held = await image(file, 16777216)
    files.push(receipt({ path: file, bytes: held.raw.length, sha256: held.digest, tuple: held.tuple }))
  }
  check(isDeepStrictEqual(tuple(before), tuple(await lstat(root, { bigint: true }))), "Partial generation changed")
  return Object.freeze({ root, tuple: tuple(before), files: Object.freeze(files), spaces: Object.freeze(spaces) })
}

export async function inspect(entry: { setup: unknown; managed?: unknown; launch?: unknown }, pending: unknown) {
  check(pending === undefined, "Request uncertainty cannot enter generation-conflict recovery")
  const setup = parse(entry.setup)
  const cfg = descriptor(entry.managed)
  check(setup.version === 2 && cfg.version === 2, "Paired Memory generation required")
  const prior = entry.launch as { phase?: unknown; receipt?: unknown } | undefined
  check(prior?.phase === "closed", "Generation conflict requires the exact saved closed pair")
  const closed = receipt(prior.receipt)
  const reviewed = await closure(entry)
  check(isDeepStrictEqual(closed, reviewed.closed), "Closed-pair selection changed")
  const next = await launch(cfg, setup, closed)
  const partial = await snapshot(next.root)
  const held = await image(closed.path, 65536)
  check(held.digest === closed.sha256 && held.tuple === closed.tuple, "Original closure changed")
  return {
    setup,
    cfg,
    original: reviewed.original,
    held,
    selected: { request: closed.sha256 },
    outcome: "unknown" as const,
    partial,
    identities: [...reviewed.identities],
  }
}

/** A missing reservation supplies no ownership proof; native inspection must also refuse live or unreadable producers. */
export async function absent(partial: Awaited<ReturnType<typeof snapshot>>, python: string) {
  check(isDeepStrictEqual(await snapshot(partial.root), partial), "Retained partial generation changed")
  const root = normalize(partial.root).replace(/'/g, "''")
  check(path.isAbsolute(python), "Selected interpreter required")
  const exe = normalize(python).replace(/'/g, "''")
  const name = path.basename(python).replace(/'/g, "''")
  const script = `$ErrorActionPreference='Stop';$root='${root}';$exe='${exe}';$name='${name}';$rows=@(Get-CimInstance Win32_Process);foreach($row in $rows){$cmd=$row.CommandLine;$file=$row.ExecutablePath;if($cmd -and $cmd.Replace([char]92,[char]47).ToLowerInvariant().Contains($root)){throw 'Partial generation has a live owner'};$selected=$file -and $file.Replace([char]92,[char]47).ToLowerInvariant() -eq $exe;if(($selected -or $row.Name -ieq $name -or $row.Name -match '^python.*[.]exe$') -and (!$file -or !$cmd)){throw 'Interpreter ownership is unverified'};if($selected){throw 'Selected interpreter remains live; partial ownership is unverified'}};[ordered]@{owners=0;unknown=0}|ConvertTo-Json -Compress`
  const result = await command(
    powershell(),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, env: environment() },
  )
  check(isDeepStrictEqual(JSON.parse(result.stdout), { owners: 0, unknown: 0 }), "Partial owner inspection refused")
  check(isDeepStrictEqual(await snapshot(partial.root), partial), "Partial generation changed during inspection")
  return {
    receipt: result.receipt,
    qualification: "Current owner inspection only; no partial-generation retirement or settlement is claimed",
  }
}
