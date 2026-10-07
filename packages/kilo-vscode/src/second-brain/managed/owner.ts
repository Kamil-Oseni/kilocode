import { open, lstat } from "node:fs/promises"
import path from "node:path"
import type { ChildProcess } from "node:child_process"
import { isDeepStrictEqual } from "node:util"
import { spawn } from "../../util/process"
import { check, sha, document } from "../control/frames"
import { image, observe, powershell, environment } from "../control/identity"
import { command } from "../control/command"
import { packaged } from "../control/index"
import { descriptor, selection, type Descriptor } from "./descriptor"
import type { Setup } from "../settings"
import { Pair } from "./pair"
import { readiness } from "./reuse-catalog"
import { generation } from "./generation"
import type { Launch } from "./restart"

export type Receipt = Readonly<{ path: string; bytes: number; sha256: string; tuple: string }>

/** Original pipes stay retained through deadlines; this is not creation-time job containment. */
export class Pipes {
  readonly errors: Error[] = []
  readonly counts = { stdout: 0, stderr: 0 }
  readonly eof = { stdout: false, stderr: false }
  private phases = new Set<string>()
  private terminal = false
  private prestart = false
  private started = false
  private ending?: Promise<unknown>
  private readonly exit: Promise<{ code: number | null; signal: string | null }>
  private readonly closed: Promise<void>
  private readonly readers: Promise<void>[]
  constructor(readonly child: ChildProcess) {
    child.on("error", () => this.errors.push(new Error("Managed original child failed")))
    child.stdin?.on("error", () => this.errors.push(new Error("Managed original input failed")))
    this.exit = new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }))
      child.once("close", (code, signal) => {
        if (!child.pid) resolve({ code, signal })
      })
    })
    this.closed = new Promise((resolve) => child.once("close", () => resolve()))
    this.readers = ["stdout", "stderr"].map((name) => {
      const key = name as "stdout" | "stderr"
      const stream = child[key]!
      let pending = ""
      return new Promise<void>((resolve) => {
        stream.on("error", () => this.errors.push(new Error("Managed original reader failed")))
        stream.on("data", (raw: Buffer) => {
          this.counts[key] += raw.length
          if (this.counts[key] > 1048576) {
            if (this.counts[key] - raw.length <= 1048576) this.errors.push(new Error("Managed stream bound exceeded"))
            return
          }
          if (key !== "stdout") return
          pending += raw.toString("utf8")
          if (pending.length > 65536) {
            pending = ""
            this.errors.push(new Error("Managed frame bound exceeded"))
            return
          }
          while (pending.includes("\n")) {
            const index = pending.indexOf("\n")
            const line = pending.slice(0, index)
            pending = pending.slice(index + 1)
            // Producer logs are discarded; only bounded allowlisted metadata controls admission.
            let row: Record<string, unknown>
            try {
              row = JSON.parse(line)
            } catch {
              continue
            }
            this.frame(row)
          }
        })
        stream.once("end", () => {
          this.eof[key] = true
        })
        stream.once("close", () => resolve())
      })
    })
  }
  private frame(row: Record<string, unknown>) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return
    if (row?.format === "raya.memory.disposable.supervisor.phase" && typeof row.phase === "string")
      this.phases.add(row.phase)
    if (row.passed !== true || !Array.isArray(row.errors) || row.errors.length !== 0) return
    if (row.format === "raya.memory.disposable.supervisor.closed" && row.control_joined === true) this.terminal = true
    if (
      row.format === "raya.memory.disposable.supervisor.pre-start-closed" &&
      row.started === false &&
      row.gate_joined === true &&
      row.verification_joined === true
    )
      this.prestart = true
  }
  async ready(phase: string, bound = 45000, signal?: AbortSignal) {
    const until = performance.now() + bound
    while (!this.phases.has(phase)) {
      signal?.throwIfAborted()
      check(
        !this.errors.length && this.child.exitCode === null && this.child.signalCode === null,
        "Original managed startup failed",
      )
      check(performance.now() < until, "Managed startup observation expired; original owner retained")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    check(!this.errors.length, "Original managed startup is uncertain")
  }
  async start() {
    check(!this.ending && !this.errors.length && this.child.stdin, "Original managed input unavailable")
    this.started = true
    await this.write("START\n")
    check(!this.errors.length, "Original managed gate write failed")
  }
  running() {
    return (
      !this.ending &&
      this.child.exitCode === null &&
      this.child.signalCode === null &&
      !this.eof.stdout &&
      !this.eof.stderr &&
      !this.errors.length
    )
  }
  close(mode: "stop" | "eof" = "stop") {
    this.ending ??= this.finish(mode)
    return this.ending
  }
  private async finish(mode: "stop" | "eof") {
    if (this.child.stdin && !this.child.stdin.destroyed) {
      try {
        if (mode === "stop") await this.write("STOP\n")
      } catch {
        this.errors.push(new Error("Managed original stop write failed"))
      } finally {
        try {
          this.child.stdin.end()
        } catch {
          this.errors.push(new Error("Managed original input close failed"))
        }
      }
    }
    const [exit] = await Promise.all([this.exit, this.closed, ...this.readers])
    check(
      exit.code === 0 && exit.signal === null && this.eof.stdout && this.eof.stderr && !this.errors.length,
      "Original managed child or streams did not close successfully",
    )
    return Object.freeze({
      pid: this.child.pid,
      ...exit,
      eof: { ...this.eof },
      bytes: { ...this.counts },
      readersJoined: true,
      originalJoined: true,
      forced: false,
      producerRetirement: this.terminal,
      preStartRetirement: !this.started && this.prestart,
      nativeFamilyRetirement: false,
      coldSettlementAuthority: false,
    })
  }
  private write(value: "START\n" | "STOP\n") {
    return new Promise<void>((resolve) => {
      if (!this.child.stdin || this.child.stdin.destroyed) {
        this.errors.push(new Error("Managed original input was already closed"))
        resolve()
        return
      }
      this.child.stdin.write(value, (error) => {
        if (error) this.errors.push(new Error("Managed original input write failed"))
        resolve()
      })
    })
  }
}

export async function publish(file: string, value: unknown): Promise<Receipt> {
  const raw = Buffer.from(JSON.stringify(value))
  check(raw.length <= 65536, "Managed receipt exceeds bound")
  const held = await open(file, "wx", 0o600)
  try {
    await held.writeFile(raw)
    await held.sync()
  } finally {
    await held.close()
  }
  const receipt = await image(file, 65536)
  check(receipt.digest === sha(raw) && receipt.raw.equals(raw), "Managed publication readback differs")
  return Object.freeze({ path: file, bytes: raw.length, sha256: receipt.digest, tuple: receipt.tuple })
}

async function protection(root: string) {
  const script = `$ErrorActionPreference='Stop';$dir=Get-Item -LiteralPath '${root.replace(/'/g, "''")}';if(!$dir.PSIsContainer -or ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Managed root differs'};$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$allowed=@($sid.Value,'S-1-5-18','S-1-5-32-544');$acl=Get-Acl -LiteralPath $dir.FullName;$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));if(!$acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $sid.Value -or $rules.Count -ne 3 -or @($rules.IdentityReference.Value|Select-Object -Unique).Count -ne 3){throw 'Managed ACL differs'};foreach($rule in $rules){if($rule.IdentityReference.Value -notin $allowed -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl' -or $rule.InheritanceFlags -ne 'ContainerInherit,ObjectInherit' -or $rule.PropagationFlags -ne 'None' -or $rule.IsInherited){throw 'Managed rights differ'}};[ordered]@{sid=$sid.Value;protected=$true}|ConvertTo-Json -Compress`
  const output = await command(
    powershell(),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, env: environment() },
  )
  const value = JSON.parse(output.stdout) as { sid: string; protected: boolean }
  check(value.protected === true, "Managed root protection refused")
  return value.sid
}

export class ManagedOwner {
  private pair?: Pair
  private pipes?: Pipes
  private ending?: Promise<void>
  private admitted = false
  private failed = false
  private selected?: Receipt
  private original?: Receipt
  constructor(
    private cfg: Descriptor,
    private readonly setup: Setup,
    private readonly extension: string,
    private readonly record: (
      phase: "selected" | "running" | "closed" | "uncertain",
      receipt: Receipt,
      descriptor?: Descriptor,
    ) => Promise<void>,
    private readonly context?: Launch,
  ) {}

  async open(signal?: AbortSignal) {
    try {
      await this.launch(signal)
    } catch (err) {
      this.failed = true
      throw err
    }
  }
  private async launch(signal?: AbortSignal) {
    if (this.cfg.version === 2) return this.paired(signal)
    signal?.throwIfAborted()
    check(!this.pipes && !this.failed && !this.ending, "Original managed owner cannot be replaced")
    const selected = await selection(descriptor(this.cfg), this.setup)
    const sid = await protection(this.cfg.root)
    check(
      sid === this.cfg.namespaces.memory.sid && sid === this.cfg.namespaces.retrieval.sid,
      "Managed namespace owner differs",
    )
    const helper = await packaged(this.extension)
    const info = await lstat(this.cfg.root, { bigint: true })
    // Fixed create-new reservation excludes other extension hosts and remains sticky after every crash.
    const before = await publish(path.join(this.cfg.root, "managed-reservation.json"), {
      format: "raya.memory.managed.selected",
      version: 1,
      descriptor: this.cfg,
      rootIdentity: [info.dev, info.ino, info.birthtimeNs].map(String),
      images: selected.files.map((item, index) => ({
        ref: [this.cfg.python, this.cfg.supervisor, this.cfg.plan][index],
        sha256: item.digest,
        tuple: item.tuple,
      })),
      containment: "original process and pipes only",
    })
    this.selected = before
    try {
      await this.record("selected", before)
      signal?.throwIfAborted()
      const child = spawn(
        this.cfg.python.path,
        ["-I", "-S", "-B", "-u", this.cfg.supervisor.path, "--managed", this.cfg.plan.path, this.cfg.plan.sha256],
        {
          cwd: this.cfg.root,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          shell: false,
          env: {
            SystemRoot: process.env.SystemRoot!,
            WINDIR: process.env.WINDIR!,
            PATH: path.join(process.env.SystemRoot!, "System32"),
            TEMP: this.cfg.root,
            TMP: this.cfg.root,
          },
        },
      )
      this.pipes = new Pipes(child)
      await this.pipes.ready("launch-selected", 45000, signal)
      const identity = await observe(child, this.cfg.python.path, helper.helper, this.cfg.python.sha256)
      const after = await selection(this.cfg, this.setup)
      check(
        isDeepStrictEqual(
          after.files.map((item) => item.tuple),
          selected.files.map((item) => item.tuple),
        ),
        "Original managed launch inputs changed",
      )
      const original = await image(before.path, 65536)
      check(original.digest === before.sha256 && original.tuple === before.tuple, "Managed reservation rebound")
      const receipt = await publish(path.join(this.cfg.root, "managed-original.json"), {
        format: "raya.memory.managed.original",
        version: 1,
        selected: before,
        identity,
        imageObservation: "selected image hashes and CIM executable path; not mapped image memory",
        nativeFamilyRetirement: false,
      })
      this.original = receipt
      await this.record("running", receipt)
      signal?.throwIfAborted()
      await this.pipes.start()
      await this.pipes.ready("uvicorn-started", 45000, signal)
      this.admitted = true
    } catch (err) {
      this.failed = true
      const errors = [err]
      await this.record("uncertain", before).catch((error: unknown) => errors.push(error))
      await this.pipes?.close("eof").catch((error: unknown) => errors.push(error))
      throw new AggregateError(errors, "Original managed launch remains quarantined")
    }
  }
  private async paired(signal?: AbortSignal) {
    signal?.throwIfAborted()
    check(!this.pair && !this.pipes && !this.failed && !this.ending, "Original managed pair cannot be replaced")
    const pair = (this.pair = new Pair())
    const initial = await selection(descriptor(this.cfg), this.setup)
    const sid = await protection(this.cfg.root)
    check(
      sid === this.cfg.namespaces.memory.sid && sid === this.cfg.namespaces.retrieval.sid,
      "Managed paired namespace owner differs",
    )
    if (this.context) this.cfg = await generation(this.cfg, this.context, initial.files)
    const selected = this.context ? await selection(this.cfg, this.setup) : initial
    const folder = this.context?.root ?? this.cfg.root
    const helper = await packaged(this.extension)
    const info = await lstat(this.cfg.root, { bigint: true })
    const refs = [this.cfg.python, this.cfg.supervisor, this.cfg.plan, this.cfg.retrieval!]
    const before = await publish(path.join(folder, "managed-reservation.json"), {
      format: "raya.memory.managed.pair.selected",
      version: 2,
      descriptor: this.cfg,
      ...(this.context?.predecessor ? { predecessor: this.context.predecessor } : {}),
      rootIdentity: [info.dev, info.ino, info.birthtimeNs].map(String),
      images: selected.files.map((item, index) => ({ ref: refs[index], sha256: item.digest, tuple: item.tuple })),
      containment: "two original processes and their pipes only",
    })
    this.selected = before
    const originals: Partial<Record<"memory" | "retrieval", Receipt>> = {}
    try {
      await this.record("selected", before, this.context ? this.cfg : undefined)
      await pair.start(
        async (kind) => {
          signal?.throwIfAborted()
          const plan = kind === "memory" ? this.cfg.plan : this.cfg.retrieval!
          const child = spawn(
            this.cfg.python.path,
            ["-I", "-S", "-B", "-u", this.cfg.supervisor.path, "--managed", plan.path, plan.sha256],
            {
              cwd: this.cfg.root,
              stdio: ["pipe", "pipe", "pipe"],
              windowsHide: true,
              shell: false,
              env: {
                SystemRoot: process.env.SystemRoot!,
                WINDIR: process.env.WINDIR!,
                PATH: path.join(process.env.SystemRoot!, "System32"),
                TEMP: this.cfg.root,
                TMP: this.cfg.root,
              },
            },
          )
          const pipes = new Pipes(child)
          pair.hold(kind, pipes)
          await pipes.ready("launch-selected", 45000, signal)
          const identity = await observe(child, this.cfg.python.path, helper.helper, this.cfg.python.sha256)
          const after = await selection(this.cfg, this.setup)
          check(
            isDeepStrictEqual(
              after.files.map((item) => item.tuple),
              selected.files.map((item) => item.tuple),
            ),
            "Original paired inputs changed",
          )
          const reservation = await image(before.path, 65536)
          check(
            reservation.digest === before.sha256 && reservation.tuple === before.tuple,
            "Managed pair reservation rebound",
          )
          originals[kind] = await publish(path.join(folder, `managed-${kind}-original.json`), {
            format: "raya.memory.managed.pair.original",
            version: 2,
            kind,
            selected: before,
            identity,
            imageObservation: "selected image hashes and CIM executable path; not mapped image memory",
            nativeFamilyRetirement: false,
          })
          if (kind === "memory") {
            this.original = await publish(path.join(folder, "managed-original.json"), {
              format: "raya.memory.managed.pair.originals",
              version: 2,
              selected: before,
              originals,
            })
          }
          signal?.throwIfAborted()
          await pipes.start()
          await pipes.ready("uvicorn-started", 45000, signal)
          if (kind === "retrieval") await this.ready(pipes, selected.retrieval!, signal)
        },
        async () => {
          signal?.throwIfAborted()
          check(this.original, "Original paired receipt required")
          await this.record("running", this.original)
        },
      )
      this.admitted = true
    } catch (err) {
      this.failed = true
      const errors = [err]
      await this.record("uncertain", before).catch((error: unknown) => errors.push(error))
      await pair.close("eof").catch((error: unknown) => errors.push(error))
      throw new AggregateError(errors, "Original managed pair remains quarantined")
    }
  }
  private async ready(pipes: Pipes, plan: Record<string, unknown>, signal?: AbortSignal) {
    const env = plan.env as Record<string, unknown>
    const token = await image(String(env.RAYA_RETRIEVAL_TOKEN_FILE), 64)
    check(/^[a-f0-9]{64}$/.test(token.raw.toString("ascii")), "Selected Retrieval credential differs")
    const files = plan.files as { path: string; bytes: number; sha256: string }[]
    const selected = files.filter((row) => row.path === env.RAYA_RETRIEVAL_TOKEN_FILE)
    check(
      selected.length === 1 && selected[0].bytes === 64 && selected[0].sha256 === token.digest,
      "Original Retrieval credential image changed",
    )
    const until = performance.now() + 30000
    while (performance.now() < until) {
      signal?.throwIfAborted()
      check(pipes.running(), "Original Retrieval retired during readiness")
      const timeout = AbortSignal.timeout(2000)
      const response = await fetch(`http://127.0.0.1:${plan.port}/health`, {
        headers: { Authorization: "Bearer " + token.raw.toString("ascii") },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      }).catch((err: unknown) => {
        signal?.throwIfAborted()
        if (err instanceof TypeError || err instanceof DOMException) return undefined
        throw err
      })
      if (response?.ok) {
        const reader = response.body?.getReader()
        check(reader, "Retrieval health body unavailable")
        const parts: Uint8Array[] = []
        let bytes = 0
        try {
          while (true) {
            const item = await reader.read()
            if (item.done) break
            bytes += item.value.length
            check(bytes <= 65536, "Retrieval health body exceeds bound")
            parts.push(item.value)
          }
        } finally {
          await reader.cancel()
        }
        const health = document(Buffer.concat(parts), 65536).value as Record<string, unknown>
        check(pipes.running(), "Original Retrieval retired during health read")
        if (health.ready === true) {
          check(
            isDeepStrictEqual(health.source_sha256, plan.source_sha256) &&
              typeof health.owner_epoch === "string" &&
              /^[a-f0-9]{32}$/.test(health.owner_epoch),
            "Selected Retrieval readiness differs",
          )
          if (plan.retrieval_protocol === "raya.retrieval.request.settlement.v2")
            readiness(health, env.RAYA_RETRIEVAL_RELEASE_SHA256)
          return
        }
      }
      if (!response?.ok) await response?.body?.cancel()
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error("Original Retrieval readiness expired; owner retained")
  }
  private async finishpair() {
    try {
      await this.closepair()
    } catch (err) {
      this.failed = true
      const errors = [err]
      const receipt = this.original ?? this.selected
      if (receipt) await this.record("uncertain", receipt).catch((error: unknown) => errors.push(error))
      throw new AggregateError(errors, "Original paired closure remains uncertain")
    }
  }
  private async closepair() {
    const closures = await this.pair!.close()
    // Failed validation owns no child and publishes no producer closure.
    if (this.failed && Object.keys(closures).length === 0) return
    if (this.failed) throw new Error("Failed managed pair remains quarantined")
    check(this.selected && this.original, "Original paired publication references required")
    for (const kind of ["memory", "retrieval"]) {
      const closure = closures[kind] as Record<string, unknown> | undefined
      check(
        closure?.producerRetirement === true && closure.originalJoined === true && closure.readersJoined === true,
        "Original paired producer closure unavailable",
      )
    }
    const receipt = await publish(path.join(this.context?.root ?? this.cfg.root, "managed-closed.json"), {
      format: "raya.memory.managed.pair.closed",
      version: 2,
      selected: this.selected,
      original: this.original,
      closures,
      qualification: "Two original processes/streams only; no downstream family or cold settlement authority",
    })
    await this.record("closed", receipt)
  }
  valid() {
    if (this.pair) return this.admitted && !this.failed && !this.ending && this.pair.valid()
    return this.admitted && !this.failed && !this.ending && this.pipes?.running() === true
  }
  close() {
    this.ending ??= this.finish()
    return this.ending
  }
  private async finish() {
    this.admitted = false
    if (this.pair) return this.finishpair()
    // A failed preflight owns no child or producer. Cleanup retires intake only;
    // it cannot publish a closed phase or change durable uncertainty.
    if (this.failed && !this.pipes) return
    check(this.pipes, "No original managed child was started")
    const closure = await this.pipes.close()
    // A failed pre-START generation keeps its durable quarantine. Joining its
    // original executor/gate/pipes is cleanup, never a service-closed admission.
    if (
      this.failed &&
      closure &&
      typeof closure === "object" &&
      "preStartRetirement" in closure &&
      closure.preStartRetirement === true
    )
      return
    check(
      closure && typeof closure === "object" && "producerRetirement" in closure && closure.producerRetirement === true,
      "Original service producer cleanup was not observed",
    )
    check(!this.failed, "Failed managed generation remains quarantined")
    check(this.selected && this.original, "Original managed publication references required")
    const receipt = await publish(path.join(this.cfg.root, "managed-closed.json"), {
      format: "raya.memory.managed.closed",
      version: 1,
      selected: this.selected,
      original: this.original,
      closure,
      qualification: "Original process/streams only; no downstream native family or cold settlement authority",
    })
    await this.record("closed", receipt)
  }
}
