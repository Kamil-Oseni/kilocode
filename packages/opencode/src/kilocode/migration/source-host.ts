import { participantScopes } from "../cli/profile-participants"
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { mkdtemp, readFile, rename, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import z from "zod"
import { failure } from "./source-failure"
import { staged, type Phase } from "./source-stage"
import { SourceScopes } from "@opencode-ai/core/kilocode/source-scopes"
import { ConfigIntent } from "@opencode-ai/core/kilocode/config-intent"
import { stateScopes } from "./profile-scope"
import { validateObservation } from "@opencode-ai/core/kilocode/profile-observation"
import { coordinateNativeRoots } from "@opencode-ai/core/kilocode/profile-maintenance"
import { canonical, image } from "../daemon/ownership"
import { watch } from "../daemon/exit"
import { PowerShell, pwsh } from "../shell/shell"
import { fingerprint } from "../cli/profile-retirement"
import {
  brokerCurrent,
  captureCurrent,
  context,
  handoffContext,
  readHandoff,
  observe,
  parseTicket,
} from "@opencode-ai/core/kilocode/source-launch"
import { covers, validatePolicy } from "@opencode-ai/core/kilocode/source-policy"
import { DescriptorSchema, type Descriptor } from "@opencode-ai/core/kilocode/source-pipe"
import { ExportFileSchema, ExportResultSchema } from "@opencode-ai/core/kilocode/source-export"

const uuid = z.string().uuid()
const identity = z
  .object({
    pid: z.number().int().positive(),
    birth: z.string().regex(/^\d{1,20}$/),
    executable: z.string(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
const request = z
  .object({
    version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    generation: uuid,
    id: uuid,
    runID: z.string().min(1).max(256),
    source: identity,
    roots: z
      .array(z.object({ kind: z.enum(["sqlite", "json"]), path: z.string() }).strict())
      .min(1)
      .max(4096),
    control: z.string(),
    job: z.unknown().optional(),
    pipe: DescriptorSchema.optional(),
    purpose: z.literal("export").optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.version !== 1) !== (value.job !== undefined))
      ctx.addIssue({ code: "custom", message: "Source handoff containment version differs" })
    if (value.purpose && (value.version !== 3 || !value.pipe))
      ctx.addIssue({ code: "custom", message: "Source export requires producer policy and private pipe" })
  })
type Request = z.infer<typeof request>
type Roots = Awaited<ReturnType<typeof validateObservation>>["roots"]
type Closure = Readonly<{
  proof: Awaited<Awaited<ReturnType<typeof observe>>["done"]>
  ack: Readonly<{
    version: Request["version"]
    generation: string
    id: string
    runID: string
    source: Readonly<Request["source"]>
    success: true
    roots: Awaited<ReturnType<typeof validateObservation>>
    scopes?: z.infer<typeof SourceScopes>
  }>
  policy: Awaited<ReturnType<typeof validatePolicy>>
  seed: Roots
  roots: Roots
  pipe?: Descriptor
  purpose?: "export"
}>
const closures = new WeakMap<object, Closure>()
const capsules = new WeakMap<object, string>()

/** Only a live authenticated successor callback can resolve this process-local token. */
export function assertRetirement(value: unknown): Closure {
  const closure = typeof value === "object" && value !== null ? closures.get(value) : undefined
  if (!closure) throw new Error("Source retirement callback authority is unavailable or expired")
  return closure
}

/** Verify safe host evidence only during the authenticated retirement callback. */
export function verifyCapsule(token: object, text: string, signature: string) {
  assertRetirement(token)
  const secret = capsules.get(token)
  if (!secret || !/^[a-f0-9]{64}$/.test(signature)) return false
  const expected = createHmac("sha256", secret).update(text).digest()
  return timingSafeEqual(expected, Buffer.from(signature, "hex"))
}

/** A serialized observation never enters this callback or grants capture authority. */
export function withRetirement(body: (token: object) => Promise<void>) {
  return run(body)
}
type State = { value: Request; secret: string; controller: number; final?: Promise<void> }
let state: State | undefined
let signature: string | undefined
let capturing = false
let pending:
  | Promise<Readonly<{ controller: number; birth: string; control: string; generation: string; id: string }>>
  | undefined

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
const argument = (value: string) => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`
const key = (root: { kind: string; path: string }) =>
  `${root.kind}:${process.platform === "win32" ? root.path.toLowerCase() : root.path}`
const signed = (value: unknown, secret: string) =>
  createHmac("sha256", Buffer.from(secret, "hex")).update(JSON.stringify(value)).digest("hex")

async function atomic(file: string, value: unknown) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 })
  await rename(temp, file)
}

async function bounded(file: string) {
  const data = await readFile(file)
  if (data.length > 512 * 1024) throw new Error("Source handoff metadata exceeded bound")
  return JSON.parse(data.toString("utf8")) as unknown
}

function observation(roots: Request["roots"]) {
  return {
    format: "raya.profile-root-observation",
    version: 1,
    roots,
    inventory: fingerprint(roots),
    observation: "participating-roots",
    processLocal: true,
    participantOnly: true,
    cooperativeOnly: true,
    completeProfileCoverage: false,
    portableCaptureAuthorized: false,
    portable: false,
  }
}

/** Await READY only. Awaiting the successor's completion here would deadlock against this source's exit. */
export function prepare(input: {
  scope: readonly Readonly<{ kind: "sqlite" | "json"; path: string }>[]
  expected: { executable: string; digest: string }
  command?: readonly string[]
  id?: string
  pipe?: Descriptor
  purpose?: "export"
}) {
  const scope = input.scope.map((root) => ({ ...root }))
  const expected = { ...input.expected }
  const explicit = Boolean(input.command)
  const id = input.id === undefined ? undefined : uuid.parse(input.id)
  const pipe = input.pipe === undefined ? undefined : DescriptorSchema.parse(input.pipe)
  const purpose = input.purpose === undefined ? undefined : z.literal("export").parse(input.purpose)
  const command = input.command
    ? [...input.command]
    : /^bun(?:\.exe)?$/i.test(path.basename(process.execPath))
      ? [
          process.execPath,
          "run",
          "--conditions=browser",
          path.resolve(import.meta.dir, "../../index.ts"),
          "__profile-source-successor",
        ]
      : [process.execPath, "__profile-source-successor"]
  const selected = JSON.stringify({ scope, expected, command, id, pipe, purpose })
  if (pending) {
    if (signature !== selected) return Promise.reject(new Error("Source handoff preparation identity differs"))
    return pending
  }
  signature = selected
  pending = (async () => {
    const actual = await image(process.pid)
    if (actual.executable !== (await canonical(expected.executable)) || actual.digest !== expected.digest)
      throw new Error("Source executable does not match trusted pinned identity")
    if (!command[0] || (await canonical(command[0])) !== actual.executable)
      throw new Error("Source successor executable does not match trusted pinned identity")
    if (
      !/^bun(?:\.exe)?$/i.test(path.basename(process.execPath)) &&
      (command.length !== 2 || command[1] !== "__profile-source-successor")
    )
      throw new Error("Compiled source successor route differs")
    const roots = (await validateObservation(observation(scope))).roots
    const job = await context()
    if (pipe && (!job || job.header.version !== 2)) throw new Error("Private source handoff requires a producer policy")
    if (
      pipe &&
      job &&
      (pipe.server.executable.toLowerCase() !== job.image.executable.toLowerCase() ||
        pipe.server.digest !== job.image.digest)
    )
      throw new Error("Private source pipe is not the pinned helper")
    if (job) {
      const selected = new Set(roots.map(key))
      if (job.header.roots.length !== selected.size || job.header.roots.some((root) => !selected.has(key(root))))
        throw new Error("Source Job declared scope differs from handoff scope")
    }
    const control = await mkdtemp(path.join(os.tmpdir(), "raya-source-successor-"))
    const outside = (left: string, right: string) => {
      const relative = path.relative(left, right)
      return relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)
    }
    const resolved = await canonical(control)
    if (roots.some((root) => !outside(root.path, resolved) || !outside(resolved, root.path)))
      throw new Error(`Source successor control directory overlaps selected profile; retained at ${control}`)
    const value = request.parse({
      version: job ? (job.header.version === 2 ? 3 : 2) : 1,
      generation: crypto.randomUUID(),
      id: id ?? crypto.randomUUID(),
      runID: process.env.KILO_RUN_ID ?? crypto.randomUUID(),
      source: { pid: process.pid, ...actual },
      roots,
      control,
      ...(job ? { job } : {}),
      ...(pipe ? { pipe } : {}),
      ...(purpose ? { purpose } : {}),
    })
    const secret = randomBytes(32).toString("hex")
    await atomic(path.join(control, "request.json"), { value, digest: signed(value, secret) })
    const env = { ...process.env }
    for (const name of Object.keys(env))
      if (
        name.startsWith("OTEL_") ||
        /^(?:RAYA|KILO|OPENCODE)_(?:DAEMON|SOURCE|CONTROLLER|HOST|PARENT|CONFIG|PROJECT|PLUGIN|RUNTIME)(?:_|$)/.test(
          name,
        ) ||
        name.startsWith("KILO_TEST_") ||
        /(API_KEY|TOKEN|SECRET)$/.test(name)
      )
        delete env[name]
    Object.assign(env, {
      HOME: control,
      USERPROFILE: control,
      KILO_TEST_HOME: control,
      XDG_DATA_HOME: path.join(control, "data"),
      XDG_CONFIG_HOME: path.join(control, "config"),
      XDG_STATE_HOME: path.join(control, "state"),
      XDG_CACHE_HOME: path.join(control, "cache"),
      RAYA_DB: path.join(control, "unused.db"),
      KILO_DB: path.join(control, "unused.db"),
      RAYA_AUTH_CONTENT: "{}",
      KILO_AUTH_CONTENT: "{}",
      RAYA_SOURCE_HANDOFF_CONTROL: control,
      RAYA_SOURCE_HANDOFF_CHANNEL: secret,
      ...(pipe ? { RAYA_SOURCE_HANDOFF_PIPE: pipe.name } : {}),
    })
    const controller = job
      ? await (async () => {
          const args = /^bun(?:\.exe)?$/i.test(path.basename(process.execPath))
            ? await (async () => {
                if (explicit && (command.length !== 2 || !path.isAbsolute(command[1]) || !command[1].endsWith(".ts")))
                  throw new Error("Interpreted source broker requires one fixture module")
                const shim = path.join(control, "successor.ts")
                const body = explicit
                  ? `await import(${JSON.stringify(command[1])})\n`
                  : `const { successor } = await import(${JSON.stringify(path.resolve(import.meta.dir, "source-host.ts"))}); const { finish } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../cli/finish.ts"))}); try { await successor() } catch { process.exitCode = 1; process.stderr.write("Raya source handoff failed.\\n") } finally { await finish([]) }\n`
                await writeFile(shim, body, { flag: "wx", mode: 0o600 })
                return [shim]
              })()
            : ["__profile-source-successor"]
          const names = new Set([
            "PATH",
            "SYSTEMROOT",
            "HOME",
            "USERPROFILE",
            "LOCALAPPDATA",
            "KILO_TEST_HOME",
            "XDG_DATA_HOME",
            "XDG_CONFIG_HOME",
            "XDG_STATE_HOME",
            "XDG_CACHE_HOME",
            "RAYA_DB",
            "KILO_DB",
            "RAYA_AUTH_CONTENT",
            "KILO_AUTH_CONTENT",
            "RAYA_SOURCE_HANDOFF_CONTROL",
            "RAYA_SOURCE_HANDOFF_CHANNEL",
            "RAYA_SOURCE_HANDOFF_PIPE",
          ])
          const isolated = Object.fromEntries(
            Object.entries(env).filter(
              (entry): entry is [string, string] => names.has(entry[0].toUpperCase()) && entry[1] !== undefined,
            ),
          )
          Object.assign(isolated, { TEMP: path.join(control, "tmp"), TMP: path.join(control, "tmp") })
          const broker = await brokerCurrent({ expected, request: value.id, directory: control, args, env: isolated })
          if (!broker.outsideJob) throw new Error("Source successor remains inside its source Job")
          return broker.pid
        })()
      : await (async () => {
          const shell = pwsh()
          if (!shell) throw new Error("Native source successor launcher unavailable")
          const args = command
            .slice(1)
            .map((value) => quote(argument(value)))
            .join(",")
          const launched = path.join(control, "controller.json")
          const script = `$ErrorActionPreference='Stop'; $child=Start-Process -WindowStyle Hidden -FilePath ${quote(command[0])} -ArgumentList @(${args}) -RedirectStandardOutput ${quote(path.join(control, "stdout.log"))} -RedirectStandardError ${quote(path.join(control, "stderr.log"))} -PassThru; [IO.File]::WriteAllText(${quote(launched)}, [string]$child.Id); exit 0`
          const launcher = Bun.spawn([shell, ...PowerShell.args(script)], {
            env,
            stdout: "ignore",
            stderr: Bun.file(path.join(control, "launcher.log")),
            windowsHide: true,
          })
          const code = await launcher.exited
          const errors = await readFile(path.join(control, "launcher.log"), "utf8")
          if (code !== 0)
            throw new Error(`Source successor launch failed; retained at ${control}: ${errors.slice(0, 256)}`)
          return z
            .number()
            .int()
            .positive()
            .parse(await bounded(launched))
        })()
    const witness = await image(controller)
    if (witness.executable !== actual.executable || witness.digest !== actual.digest)
      throw new Error(`Source successor executable changed; retained at ${control}`)
    state = { value, secret, controller }
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      const ready = await bounded(path.join(control, "ready.json")).catch((err: unknown) => {
        if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined
        throw err
      })
      if (ready) {
        const parsed = z
          .object({
            version: z.literal(value.version),
            generation: z.literal(value.generation),
            id: z.literal(value.id),
            controller: z.literal(controller),
            source: identity,
          })
          .strict()
          .parse(ready)
        if (JSON.stringify(parsed.source) !== JSON.stringify(value.source))
          throw new Error("Source successor READY identity differs")
        if (job) await captureCurrent()
        return Object.freeze({ controller, birth: witness.birth, control, generation: value.generation, id: value.id })
      }
      await Bun.sleep(50)
    }
    throw new Error(`Source successor READY refused; diagnostics retained at ${control}`)
  })()
  return pending
}

/** Root outer finish calls this after runtime and child cleanup, before lifetime release and native exit. */
export function finalize(success: boolean): Promise<void> {
  if (!state) return Promise.resolve()
  const selected = state
  return (selected.final ??= (async () => {
    const { observation } = await import("../cli/profile-retirement")
    await ConfigIntent.retire()
    const roots = await validateObservation(observation())
    const scopes = participantScopes(selected.value.purpose === "export")
    const value = {
      version: selected.value.version,
      generation: selected.value.generation,
      id: selected.value.id,
      runID: selected.value.runID,
      source: selected.value.source,
      success,
      roots,
      ...(selected.value.version === 3 ? { scopes } : {}),
    }
    const envelope = { value, digest: signed(value, selected.secret) }
    if (Buffer.byteLength(JSON.stringify(envelope)) > 512 * 1024)
      throw new Error("Source handoff acknowledgment metadata exceeded bound")
    await atomic(path.join(selected.value.control, "ack.json"), envelope)
  })())
}

/** Capture cleanup includes persistent descendants; ordinary serve shutdown may preserve them. */
export function captureRequested() {
  return capturing
}

/** Root-only private intake. Close joins preparation, never the shutdown it has just triggered. */
export async function listen(run: () => Promise<void>) {
  const job = await handoffContext()
  if (!job) return () => Promise.resolve()
  const actor: {
    closed: boolean
    failures: unknown[]
    pending?: Promise<void>
    closing?: Promise<void>
    timer?: ReturnType<typeof setTimeout>
  } = { closed: false, failures: [] }
  const fire = () => {
    void Promise.resolve()
      .then(run)
      .catch((err: unknown) => {
        actor.failures.push(err)
        process.exitCode = 1
      })
  }
  const step = async () => {
    try {
      // Idle polling must not create thousands of retained native helper processes.
      if (!(await Bun.file(`${job.control}.source-handoff`).exists()) || actor.closed) return
      const value = await readHandoff(job)
      if (!value || actor.closed) return
      actor.closed = true // Reserve one authenticated request before any asynchronous preparation.
      capturing = true
      const ticket = await prepare({
        scope: job.header.roots,
        expected: { executable: job.header.executable, digest: job.header.digest },
        id: value.id,
        pipe: value.pipe,
        purpose: value.purpose,
      })
      const response = { version: 1, token: job.token, id: value.id, source: value.source, successor: ticket }
      await atomic(`${job.control}.source-handoff-ready`, {
        value: response,
        signature: createHmac("sha256", job.token).update(JSON.stringify(response)).digest("hex"),
      })
      fire()
    } catch (err) {
      actor.closed = true
      actor.failures.push(err)
      process.exitCode = 1
      fire()
    }
  }
  const poll = () => {
    if (actor.closed || actor.pending) return
    actor.pending = step().finally(() => {
      actor.pending = undefined
      if (!actor.closed) actor.timer = setTimeout(poll, 250)
    })
  }
  poll()
  return () =>
    (actor.closing ??= (async () => {
      actor.closed = true
      clearTimeout(actor.timer)
      await actor.pending
      if (actor.failures.length) throw new AggregateError(actor.failures, "Source handoff intake failed")
    })())
}

/** Private successor owns the native watcher and gates. Evidence remains scoped; no capture capability is minted. */
export async function successor() {
  return run()
}

async function run(body?: (token: object) => Promise<void>) {
  const control = process.env.RAYA_SOURCE_HANDOFF_CONTROL
  const secret = process.env.RAYA_SOURCE_HANDOFF_CHANNEL
  if (!control || !path.isAbsolute(control) || !secret || !/^[a-f0-9]{64}$/.test(secret))
    throw new Error("Source successor identity unavailable")
  const envelope = z
    .object({ value: request, digest: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict()
    .parse(await bounded(path.join(control, "request.json")))
  const value = envelope.value
  if (
    control !== value.control ||
    !timingSafeEqual(Buffer.from(envelope.digest, "hex"), Buffer.from(signed(value, secret), "hex"))
  )
    throw new Error("Source successor authentication differs")
  const job = value.version !== 1 ? parseTicket(value.job) : undefined
  const receiver = value.purpose ? { pid: process.pid, ...(await image(process.pid)) } : undefined
  let artifact: z.infer<typeof ExportFileSchema> | undefined
  const callback =
    body ??
    (value.purpose === "export"
      ? async (token: object) => {
          const { capture } = await import("./source-capture")
          artifact = ExportFileSchema.parse(await capture(token))
        }
      : undefined)
  let observer: Awaited<ReturnType<typeof watch>> | undefined
  let family: Awaited<ReturnType<typeof observe>> | undefined
  let phase: Phase | undefined = "source-image"
  try {
    const actual = await image(value.source.pid)
    phase = "source-binding"
    if (
      JSON.stringify(actual) !==
      JSON.stringify({ birth: value.source.birth, executable: value.source.executable, digest: value.source.digest })
    )
      throw new Error("Source native identity changed")
    phase = "root-policy"
    await validateObservation(observation(value.roots))
    const policy = job && "policy" in job.header ? await validatePolicy(job.header.policy) : undefined
    if ((value.version === 3) !== Boolean(policy)) throw new Error("Source policy handoff version differs")
    if (job) {
      phase = "job-binding"
      if (
        job.header.pid !== value.source.pid ||
        job.header.birth !== value.source.birth ||
        (await canonical(job.header.executable)) !== value.source.executable ||
        job.header.digest !== value.source.digest ||
        job.header.roots.length !== value.roots.length ||
        job.header.roots.some((root, index) => key(root) !== key(value.roots[index]))
      )
        throw new Error("Source Job identity differs from authenticated handoff")
      phase = "family-ready"
      family = await observe(job)
      await family.ready
    }
    const closure = family?.done.then(
      (result) => ({ result }),
      (failure: unknown) => ({ failure }),
    )
    phase = "watch-ready"
    observer = await watch(value.source.pid, value.source.birth, 60_000)
    phase = "control-ready"
    await atomic(path.join(control, "ready.json"), {
      version: value.version,
      generation: value.generation,
      id: value.id,
      controller: process.pid,
      source: value.source,
    })
    phase = "watch-exit"
    const exited = await observer.done
    if (exited.code !== 0) throw new Error("Source native exit is unsuccessful or forced")
    phase = "signed-ack"
    const raw = z
      .object({
        value: z
          .object({
            version: z.literal(value.version),
            generation: z.literal(value.generation),
            id: z.literal(value.id),
            runID: z.literal(value.runID),
            source: identity,
            success: z.literal(true),
            roots: z.unknown(),
            scopes: SourceScopes.optional(),
          })
          .strict(),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(await bounded(path.join(control, "ack.json")))
    if (
      JSON.stringify(raw.value.source) !== JSON.stringify(value.source) ||
      !timingSafeEqual(Buffer.from(raw.digest, "hex"), Buffer.from(signed(raw.value, secret), "hex"))
    )
      throw new Error("Source retirement acknowledgment identity differs")
    phase = "observation-roots"
    const roots = await validateObservation(raw.value.roots)
    phase = "state-scope"
    if (value.purpose === "export" && !raw.value.scopes)
      throw new Error("Source export lacks authenticated Global namespace identities")
    if (value.purpose === "export" && raw.value.scopes?.version !== 4)
      throw new Error("Source export lacks authenticated configuration origin evidence")
    if (value.purpose === "export" && raw.value.scopes?.version === 4 && raw.value.scopes.configStatus !== "complete")
      throw new Error("Source export configuration origin evidence is incomplete")
    if (raw.value.scopes) {
      if (!policy) throw new Error("Source state metadata requires producer policy")
      await stateScopes(raw.value.scopes, roots.roots, policy, value.purpose === "export")
    }
    phase = "historical-policy"
    const declared = new Set(value.roots.map(key))
    if (roots.roots.some((root) => !(policy ? covers(policy, root.path) : declared.has(key(root)))))
      throw new Error("Source scope omits historical participant roots")
    phase = "family-closure"
    const closed = await closure
    if (closed && "failure" in closed) throw closed.failure
    // Revalidate policy after the source and its whole native family have stopped.
    phase = "retired-policy"
    if (policy) await validatePolicy(policy)
    phase = "union-roots"
    const union = [...new Map([...value.roots, ...roots.roots].map((root) => [key(root), root])).values()].sort(
      (left, right) => (key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0),
    )
    const selected = (await validateObservation(observation(union))).roots
    if (callback) {
      phase = "export-callback"
      if (!job || !policy || !closed || !("result" in closed))
        throw new Error("Producer-bound source retirement is unavailable")
      const token = Object.freeze({})
      capsules.set(token, job.token)
      closures.set(
        token,
        Object.freeze({
          proof: closed.result,
          ack: Object.freeze({ ...raw.value, source: Object.freeze({ ...raw.value.source }), roots }),
          policy,
          seed: (await validateObservation(observation(value.roots))).roots,
          roots: selected,
          ...(value.pipe
            ? { pipe: Object.freeze({ ...value.pipe, server: Object.freeze({ ...value.pipe.server }) }) }
            : {}),
          ...(value.purpose ? { purpose: value.purpose } : {}),
        }),
      )
      try {
        await callback(token)
      } finally {
        closures.delete(token)
        capsules.delete(token)
      }
    }
    phase = "held-admission"
    const expected = new Set(selected.map(key))
    const result = await coordinateNativeRoots(selected, async (admission) => {
      if (admission.roots.length !== expected.size || admission.roots.some((root) => !expected.has(key(root))))
        throw new Error("Source scope identity changed before held gates")
      return admission
    })
    phase = "result-publication"
    await atomic(path.join(control, "result.json"), {
      version: value.version,
      generation: value.generation,
      id: value.id,
      status: "observed",
      source: value.source,
      exit: exited,
      ...(closed && "result" in closed ? { family: closed.result } : {}),
      roots,
      admission: result.value,
      completeProfileCoverage: false,
      portableCaptureAuthorized: false,
    })
    if (value.purpose && job && receiver) {
      if (!artifact) throw new Error("Source export produced no publication")
      const result = ExportResultSchema.parse({
        format: "raya.source-export-result",
        version: 1,
        id: value.id,
        generation: value.generation,
        source: value.source,
        receiver,
        status: "exported",
        artifact,
        completeProfileCoverage: false,
        portableCaptureAuthorized: false,
      })
      await atomic(`${job.control}.source-export-result`, {
        result,
        signature: createHmac("sha256", job.token).update(JSON.stringify(result)).digest("hex"),
      })
    }
  } catch (err) {
    const error = phase ? staged(err, phase) : err
    process.exitCode = 1
    await atomic(path.join(control, "result.json"), {
      version: value.version,
      generation: value.generation,
      id: value.id,
      status: "refused",
      reason: "Source handoff failed",
      failure: failure(error),
      completeProfileCoverage: false,
      portableCaptureAuthorized: false,
    })
    if (value.purpose && job && receiver) {
      const result = ExportResultSchema.parse({
        format: "raya.source-export-result",
        version: 1,
        id: value.id,
        generation: value.generation,
        source: value.source,
        receiver,
        status: "refused",
        completeProfileCoverage: false,
        portableCaptureAuthorized: false,
      })
      await atomic(`${job.control}.source-export-result`, {
        result,
        signature: createHmac("sha256", job.token).update(JSON.stringify(result)).digest("hex"),
      })
    }
  } finally {
    await observer?.close()
    await family?.close()
  }
}
