import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { readdir, lstat } from "node:fs/promises"
import { z } from "zod"
import { check, document } from "./control/frames"
import { image, directory, environment, powershell } from "./control/identity"
import { command } from "./control/command"
import { held } from "./control/transport"
import { receipt } from "./managed/descriptor"
import { review as closed, absent } from "./closed-recovery"
import { parse } from "./settings"
import { parseCatalog } from "./control/catalog"
import { fingerprint } from "./failed-repair"
import { records } from "./capture-intake"

const keys = [
  "raya.secondBrain.setup",
  "raya.secondBrain.control.catalog",
  "raya.secondBrain.personalCapture",
  "raya.secondBrain.personalCapture.turns",
  "raya.secondBrain.personalCapture.failures",
] as const
const row = z.record(z.string(), z.unknown())
const object = (input: unknown) => row.parse(input)
const debt = "raya.secondBrain.control.uncertainty"
const id = "10481dda-9fa6-5d75-9af6-dd825c94ef36"
const head = "d6c9a455a1a9022b82e058ad69fe1a93118d5441"
const version = "7.4.23-snapshot+d6c9a455a1.local.1791998767146"
const origin = "0c75ad3254fb85a0a187a6dfd69ebf3774ceaeb322eaa793a4e7de1b40993c85"
type Storage = { get<T>(key: string): T | undefined }
const schema = z
  .object({
    format: z.literal("raya.capture.authorization.disposition.review"),
    version: z.literal(1),
    original: z.unknown(),
    failures: z.unknown(),
    health: z.unknown(),
    qualification: z.unknown(),
    seal: z.unknown(),
    install: z.unknown(),
    cold: z.unknown(),
    manifest: z.unknown(),
    binding: z.unknown(),
  })
  .strict()

async function read(input: unknown, digest?: string, bytes?: number) {
  const ref = receipt(input)
  const value = await image(ref.path, bytes ?? 1048576)
  check(
    value.digest === ref.sha256 && value.raw.length === ref.bytes && value.tuple === ref.tuple,
    "Original unpublished capture evidence changed",
  )
  check(
    (digest === undefined || value.digest === digest) && (bytes === undefined || value.raw.length === bytes),
    "Exact original producer evidence required",
  )
  document(value.raw, bytes ?? 1048576, 200000)
  return object(JSON.parse(value.raw.toString("utf8")))
}
function snapshot(storage: Storage) {
  check(storage.get(debt) === undefined, "Original control mutation debt cannot be disposed as unpublished")
  return Object.fromEntries(keys.map((key) => [key, structuredClone(storage.get(key))]))
}
function same(storage: Storage, state: ReturnType<typeof snapshot>) {
  check(isDeepStrictEqual(snapshot(storage), state), "Unpublished capture binding changed")
}

function attempt(original: Record<string, unknown>, failure: Record<string, unknown>) {
  const session = object(original.session)
  const turn = records([original.ledger])[0]
  const diagnostic = object(z.array(z.unknown()).length(1).parse(failure.failureAudit)[0])
  check(
    turn.id === id &&
      turn.phase === "uncertain" &&
      turn.receipt === undefined &&
      turn.source_sha256 === "4e6578c0e6c75de7405a335186d008892eea0ba55e4176aca875d6b9a28a2605" &&
      turn.release === "d40ac9d0d13f84b77637f9dd959b0b718602d976663ec2ead8e683678c756d7d" &&
      session.id === turn.sessionID &&
      session.version === "7.4.23-raya.d6c9a455a1.20261014",
    "Exact original uncertain authorization attempt required",
  )
  check(
    diagnostic.id === id &&
      diagnostic.stage === "authorization" &&
      isDeepStrictEqual(diagnostic.errors, ["unclassified", "unclassified"]) &&
      failure.capture === id &&
      original.active_control_uncertainty === false &&
      original.observed_capture_folder_exists === false &&
      original.observed_change_folder_exists === false,
    "Original authorization-stage diagnostic required",
  )
  return { turn, diagnostic }
}

function producer(
  health: Record<string, unknown>,
  qualification: Record<string, unknown>,
  seal: Record<string, unknown>,
  install: Record<string, unknown>,
) {
  check(
    qualification.artifactQualified === true &&
      qualification.head === head &&
      qualification.version === version &&
      object(qualification.archive).sha256 === "9c6ba5bb9d87afbe8b3b960a93d98d94e91ce29f3cf06e1e41e745edc18c4704" &&
      qualification.bridge === origin &&
      seal.head === head &&
      install.passed === true &&
      install.version === version &&
      install.exactNonPackagePayloads === 542 &&
      health.version === version &&
      object(health.backend).sha256 === object(qualification.cli).sha256,
    "Original installed producer and source seal differ",
  )
  const code = z
    .array(z.unknown())
    .parse(seal.files)
    .map(object)
    .find((row) => row.relative === "packages/kilo-vscode/src/second-brain/control.ts")
  check(
    code?.sha256 === "6bf9f87beaf45e21bab711a5518b733338c6d3dee05d5078a2029ed9f3cadda3",
    "Frozen authorization-before-publication implementation required",
  )
}

function lineage(
  health: Record<string, unknown>,
  qualification: Record<string, unknown>,
  cold: Record<string, unknown>,
  turn: ReturnType<typeof records>[number],
  diagnostic: Record<string, unknown>,
) {
  const prior = object(health.selected)
  const source = parse(prior.setup)
  check(
    source.version === 2 &&
      source.root === turn.root &&
      fingerprint(source.source_sha256) === turn.release &&
      isDeepStrictEqual(source.source_sha256, qualification.releaseModules) &&
      isDeepStrictEqual(cold.originalCapture, [turn]) &&
      isDeepStrictEqual(cold.originalFailure, [diagnostic]),
    "Original source, closure observation and attempt differ",
  )
}

/** Source-bound evidence only. This does not admit disposition or native activity. */
export async function inspect(input: unknown, storage: Storage) {
  const witness = schema.parse(input)
  const original = await read(
    witness.original,
    "e8947434f7c195f3a0d84201fb192195941f47e03f0dde15e3880cb86607ec6c",
    6397,
  )
  const failure = await read(witness.failures, "723bbfab4a9fa082e274ded824cb9a65b812fc378e6bf96204a85e71809cd758", 713)
  const health = await read(witness.health, "7b8cbd09f2f0d5c090a9793a983fc8e4dfe2847bf059751eca166f5c9c37a362", 7836)
  const qualification = await read(
    witness.qualification,
    "25cc8ef321d8ff4e42d58f1abf7ebf7afd59f7e81d7480335d61434d7b53f114",
    4244,
  )
  const seal = await read(witness.seal, "1a5959da41d1dde9e4dd1f6f374112a7092866e11cad912a04b1d78059675498", 2556094)
  const install = await read(witness.install, "6c5540ceb7143d2dd21d1e34f2e0e3c59ddfa372b8a04a7e594f58e5752d64cb", 1817)
  const cold = await read(witness.cold, "412623a9b6804fcbdf6f543ff01885cb05ecf5f8308589ef686f1016cebf38f3", 4143)
  const manifest = await read(witness.manifest, "c810ce486cdf09b78b3ac529ccb81ac46741a384ef5c68777a4b94d7453a6f20")
  const binding = await read(witness.binding)
  const evidence = attempt(original, failure)
  const turn = evidence.turn
  const diagnostic = evidence.diagnostic
  producer(health, qualification, seal, install)
  lineage(health, qualification, cold, turn, diagnostic)
  const state = snapshot(storage)
  const entry = object(state[keys[0]])
  const setup = parse(entry.setup)
  const catalog = object(state[keys[1]])
  const control = parseCatalog(catalog.catalog)
  const consent = object(state[keys[2]])
  const launch = object(entry.launch)
  const saved = records(state[keys[3]])
  const audit = storage.get<{ original?: unknown; completed?: unknown; phase?: string }>(
    `raya.secondBrain.captureUnpublished.${id}`,
  )
  const current = saved.find((row) => row.id === id)
  const completed = { ...turn, phase: "skipped" as const }
  const bound = { ...state, [keys[3]]: saved.map((row) => (row.id === id ? turn : row)) }
  check(isDeepStrictEqual(binding, bound), "Current cold binding differs from reviewed snapshot")
  check(
    isDeepStrictEqual(current, turn) ||
      (!!audit &&
        isDeepStrictEqual(audit.original, turn) &&
        isDeepStrictEqual(audit.completed, completed) &&
        isDeepStrictEqual(current, completed)),
    "Original uncertain row changed",
  )
  check(
    Array.isArray(state[keys[4]]) &&
      z
        .array(z.unknown())
        .parse(state[keys[4]])
        .some((row) => isDeepStrictEqual(row, diagnostic)),
    "Original failure audit changed",
  )
  check(
    setup.version === 2 &&
      setup.root === turn.root &&
      fingerprint(setup.source_sha256) === turn.release &&
      control.version === 2 &&
      catalog.root === turn.root &&
      isDeepStrictEqual(control.source_sha256, setup.source_sha256) &&
      consent.root === turn.root &&
      consent.release === turn.release &&
      launch.phase === "closed",
    "Current exact closed source/control/consent binding required",
  )
  check(
    manifest.source === turn.root && manifest.count === 211 && manifest.bytes === 1369861,
    "Original unchanged notes manifest required",
  )
  same(storage, state)
  return {
    witness,
    original: turn,
    completed,
    diagnostic,
    state,
    manifest,
    bindingSHA: fingerprint(binding),
    failuresSHA: fingerprint({ failures: state[keys[4]] }),
    ledgerSHA: fingerprint({ turns: saved.map((row) => (row.id === id ? turn : row)) }),
  }
}

async function notes(root: string, manifest: Record<string, unknown>) {
  await directory(root)
  const expected = object(manifest.files)
  const files: string[] = []
  let visits = 0
  const walk = async (dir: string, depth = 0) => {
    check(++visits <= 1024 && depth <= 32, "Original notes traversal exceeds its bound")
    for (const name of await readdir(dir)) {
      const file = path.join(dir, name)
      const stat = await lstat(file)
      check(!stat.isSymbolicLink(), "Linked note paths cannot prove unpublished capture")
      if (stat.isDirectory()) {
        await directory(file)
        await walk(file, depth + 1)
        continue
      }
      check(stat.isFile() && stat.nlink === 1, "Ordinary note files required")
      files.push(path.relative(root, file))
      check(files.length <= 211, "Original notes inventory changed")
    }
  }
  await walk(root)
  check(isDeepStrictEqual(files.sort(), Object.keys(expected).sort()), "Original notes topology changed")
  for (const name of files) {
    const ref = object(expected[name])
    const file = await image(path.join(root, name), 1048576)
    check(file.raw.length === ref.bytes && file.digest === ref.sha256, "Original policy or note bytes changed")
  }
  for (const name of [path.join("System", "Capture", id), path.join("System", "Changes", id)]) {
    const found = await lstat(path.join(root, name)).then(
      () => true,
      (err) => {
        if (err.code === "ENOENT") return false
        throw err
      },
    )
    check(!found, "Original capture input or change journal exists")
  }
  return fingerprint(expected)
}

async function owners(extension: string) {
  check(held().length === 0, "Native control owner still holds this host")
  // Permit only the current reviewer's one Code family/backend; peer or
  // unknown capture-capable owners are refused without closing any app.
  const cli = path.join(extension, "bin", "kilo.exe").replace(/'/g, "''")
  const script = `
$ErrorActionPreference='Stop'
$all=@(Get-CimInstance Win32_Process)
$at=${process.pid};$main=0
for($n=0;$n -lt 64 -and $at -gt 0;$n++){
  $row=$all|Where-Object ProcessId -eq $at|Select-Object -First 1
  if(-not $row -or $row.Name -ne 'Code.exe'){break}
  $main=$at;$at=[int]$row.ParentProcessId
}
if(-not $main){throw 'Actual reviewer Code family required'}
function Descends([int]$item,[int]$ancestor){
  for($n=0;$n -lt 64 -and $item -gt 0;$n++){
    if($item -eq $ancestor){return $true}
    $row=$all|Where-Object ProcessId -eq $item|Select-Object -First 1
    if(-not $row){return $false}
    $item=[int]$row.ParentProcessId
  }
  return $false
}
$code=@($all|Where-Object Name -eq 'Code.exe')
if(@($code|Where-Object {-not (Descends $_.ProcessId $main)}).Count){throw 'Another Code family remains'}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RayaWindows {
  public delegate bool Visitor(IntPtr handle,IntPtr state);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Visitor callback,IntPtr state);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr handle);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr handle,uint command);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle,out uint process);
}
'@
$windows=New-Object System.Collections.Generic.List[int]
$visit=[RayaWindows+Visitor]{param($handle,$state)
  [uint32]$item=0
  [void][RayaWindows]::GetWindowThreadProcessId($handle,[ref]$item)
  if($item -in $code.ProcessId -and [RayaWindows]::IsWindowVisible($handle) -and [RayaWindows]::GetWindowTextLength($handle) -gt 0 -and [RayaWindows]::GetWindow($handle,4) -eq [IntPtr]::Zero){$windows.Add([int]$item)}
  return $true
}
if(-not [RayaWindows]::EnumWindows($visit,[IntPtr]::Zero) -or $windows.Count -ne 1){throw 'Exactly one native reviewer Code window required'}
$backends=@($all|Where-Object Name -eq 'kilo.exe')
if($backends.Count -gt 1 -or @($backends|Where-Object {$_.ExecutablePath -ne '${cli}' -or -not (Descends $_.ProcessId ${process.pid})}).Count){throw 'Peer or unknown backend remains'}
$other=@($all|Where-Object {
  ($_.Name -match '^python(w)?[.]exe$' -and ($null -eq $_.CommandLine -or $_.CommandLine -match 'control[.]py|supervise[.]py|service[.]server|retrieve_service[.]run|[\\\\/]memory[\\\\/].*server[.]py')) -or
  ($_.Name -match '^bun[.]exe$' -and ($null -eq $_.CommandLine -or $_.CommandLine -match '[\\\\/]opencode[\\\\/].*(serve|src[\\\\/]index[.]ts)|src[\\\\/]index[.]ts.*\\bserve\\b|\\bdev\\s+.*\\bserve\\b'))
})
if($other.Count){throw 'Capture-capable owner remains or is unknown'}
[ordered]@{otherOwners=0;reviewer=${process.pid};backends=$backends.Count;windows=$windows.Count}|ConvertTo-Json -Compress`
  const result = await command(
    powershell(),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { env: environment(), windowsHide: true },
  )
  const value = object(JSON.parse(result.stdout))
  check(
    value.otherOwners === 0 &&
      value.reviewer === process.pid &&
      value.windows === 1 &&
      [0, 1].includes(Number(value.backends)),
    "Cold owner observation refused",
  )
  return { observed: Date.now(), receipt: result.receipt, reviewer: process.pid, otherOwners: 0 }
}

/** Exact native review only: source control-flow proof is not request settlement. */
export async function review(input: unknown, storage: Storage, extension: string) {
  const proof = await inspect(input, storage)
  const entry = object(proof.state[keys[0]])
  const closure = await closed({ setup: entry.setup, managed: entry.managed, launch: entry.launch })
  const observation = await absent(closure, extension)
  const inventory = await owners(extension)
  const notesSHA = await notes(proof.original.root, proof.manifest)
  check(
    notesSHA === (await notes(proof.original.root, proof.manifest)),
    "Original notes changed during native observation",
  )
  await absent(closure, extension)
  const final = await owners(extension)
  check(
    inventory.reviewer === final.reviewer && inventory.otherOwners === final.otherOwners,
    "Cold capture owners changed",
  )
  same(storage, proof.state)
  return {
    format: "raya.capture.authorization.disposition" as const,
    version: 1 as const,
    original: proof.original,
    completed: proof.completed,
    diagnostic: proof.diagnostic,
    witness: proof.witness,
    bindingSHA: proof.bindingSHA,
    ledgerSHA: proof.ledgerSHA,
    failuresSHA: proof.failuresSHA,
    notesSHA,
    closure,
    observation,
    inventory,
    qualification:
      "Exact original authorization-stage no-publication disposition; an empty Changes directory is possible and original native frame history is missing",
    outcome: "failed_before_publication" as const,
    requestSettlement: false as const,
    indexConfirmed: false as const,
    replay: false as const,
    nativeFamilyRetirement: false as const,
  }
}
