import { spawn } from "node:child_process"
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { mkdtemp, open, readFile, realpath, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import z from "zod"
import { NativeProcess } from "./process-host"
import { read } from "./source-readiness"
import { validateObservation } from "./profile-observation"
import { observe as watch } from "./source-observer"
import { SourcePolicySchema, covers, validatePolicy, type SourcePolicy } from "./source-policy"
import { DescriptorSchema, IdentitySchema, type Descriptor } from "./source-pipe"

const uuid = z.string().uuid()
const birth = z
  .string()
  .regex(/^\d{1,20}$/)
  .refine((value) => BigInt(value) > 0n && BigInt(value) <= 0xffffffffffffffffn)
const pid = z.number().int().positive().max(0xffffffff)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const root = z.object({ kind: z.enum(["json", "sqlite"]), path: z.string().min(1).max(4096) }).strict()
const header = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    token: uuid,
    proof: z.literal("windows-job"),
    pid,
    birth,
    executable: z.string(),
    digest,
    helper: pid,
    helperBirth: birth,
    interpreted: z.boolean(),
    roots: z.array(root).min(1).max(64),
    policy: SourcePolicySchema.optional(),
    policyInventory: digest.optional(),
    state: z.literal("suspended"),
    completeProfileCoverage: z.literal(false),
    portableCaptureAuthorized: z.literal(false),
  })
  .strict()
const schema = z
  .object({
    format: z.literal("raya.source-job"),
    version: z.literal(1),
    control: z.string(),
    token: uuid,
    header,
    image: z.object({ executable: z.string(), digest }).strict(),
  })
  .strict()
export type Ticket = Readonly<
  Omit<z.infer<typeof schema>, "header" | "image"> & {
    header: Readonly<
      Omit<z.infer<typeof header>, "roots" | "policy"> & {
        roots: readonly Readonly<z.infer<typeof root>>[]
        policy?: SourcePolicy
      }
    >
    image: Readonly<z.infer<typeof schema>["image"]>
  }
>

/** Pre-Go cleanup joins the original helper; it cannot grant natural source-family retirement. */
export class LaunchFailure extends AggregateError {
  constructor(
    primary: unknown,
    failures: readonly unknown[],
    readonly cleanup: Readonly<{
      exit: { code: number | null; signal: NodeJS.Signals | null } | null
      originalExitJoined: boolean
      originalCloseJoined: boolean
      originalStreamsJoined: boolean
      ordinaryRetirement: false
      portableCaptureAuthorized: false
      forced: "unknown"
    }>,
  ) {
    super([primary, ...failures], "Source admission failed; original helper cleanup retained", { cause: primary })
    this.name = "SourceLaunchFailure"
  }
}

async function drain(stream: ReturnType<typeof spawn>["stdout"]) {
  if (!stream || stream.readableEnded) return
  if (stream.destroyed) throw stream.errored ?? new Error("Source admission output closed without EOF")
  for await (const _chunk of stream) {
    // Consume the original pipe without retaining an unbounded failed-launch payload.
  }
}

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex")
const sum = async (file: string) => hash(await readFile(file))
async function canonical(file: string): Promise<string> {
  if (!path.isAbsolute(file) || path.normalize(file) !== file || file.includes("\0"))
    throw new Error("Source launch path is not absolute and normalized")
  return realpath(file).catch(async (err: unknown) => {
    if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT" || path.dirname(file) === file) throw err
    return path.join(await canonical(path.dirname(file)), path.basename(file))
  })
}
async function roots(values: readonly { kind: "json" | "sqlite"; path: string }[]) {
  return (
    await validateObservation({
      format: "raya.profile-root-observation",
      version: 1,
      roots: values,
      inventory: hash(JSON.stringify(values.map((value) => ({ kind: value.kind, path: value.path.toLowerCase() })))),
      observation: values.length ? "participating-roots" : "no-participating-roots",
      processLocal: true,
      participantOnly: true,
      cooperativeOnly: true,
      completeProfileCoverage: false,
      portableCaptureAuthorized: false,
      portable: false,
    })
  ).roots
}
function packet(...values: (number | string)[]) {
  const chunks = values.map((value) => {
    const result = Buffer.alloc(4)
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)
        throw new Error("Source native integer invalid")
      result.writeUInt32LE(value)
      return result
    }
    if (value.includes("\0") || value.length > 32768) throw new Error("Source native field invalid")
    result.writeUInt32LE(value.length)
    return Buffer.concat([result, Buffer.from(value, "utf16le")])
  })
  const result = Buffer.concat(chunks)
  if (result.length > 1048576) throw new Error("Source native packet exceeded bound")
  return result
}
async function publish(file: string, value: Buffer, helper?: string) {
  const temp = `${file}.${randomUUID()}.tmp`
  const handle = await open(temp, "wx", 0o600)
  try {
    await handle.writeFile(value)
    await handle.sync()
  } finally {
    await handle.close()
  }
  const receipt = await NativeProcess.receipt(temp, helper)
  if (!receipt) throw new Error("Source control publication disappeared")
  await NativeProcess.move(temp, receipt, file, helper)
}
async function wait(file: string, timeout = 15000, helper?: string) {
  const end = performance.now() + timeout
  while (performance.now() < end) {
    const value = await read(file, helper, true)
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Source native response missing; evidence retained at ${file}`)
}
async function owned(value: number, expected: string, helper?: string) {
  const actual = z
    .object({ status: z.literal("owned"), birth, parent: z.number().int().nonnegative() })
    .strict()
    .parse(await NativeProcess.inspect(value, helper))
  if (actual.birth !== expected) throw new Error("Source launch exact native identity changed")
}
async function verified(ticket: Ticket) {
  const actual = header.parse(await read(`${ticket.control}.source-launch`, ticket.image.executable))
  if (JSON.stringify(actual) !== JSON.stringify(ticket.header))
    throw new Error("Source native launch observation changed")
  await roots(actual.roots)
  if (actual.version === 2) {
    const policy = await validatePolicy(actual.policy)
    if (
      hash(JSON.stringify(policy)) !== actual.policyInventory ||
      actual.roots.some((root) => !covers(policy, root.path))
    )
      throw new Error("Source producer policy identity changed")
  }
  if (
    !same(await canonical(ticket.control), ticket.control) ||
    !same(await canonical(ticket.image.executable), ticket.image.executable) ||
    (await sum(ticket.image.executable)) !== ticket.image.digest
  )
    throw new Error("Source native controller image or path changed")
  return actual
}

/** Metadata parser only: it does not grant retirement or capture authority. */
export function parseTicket(value: unknown): Ticket {
  const ticket = schema.parse(value)
  if (
    (ticket.header.version === 1 &&
      (ticket.header.policy !== undefined || ticket.header.policyInventory !== undefined)) ||
    (ticket.header.version === 2 && (!ticket.header.policy || !ticket.header.policyInventory))
  )
    throw new Error("Source policy protocol generation invalid")
  if (
    ticket.token !== ticket.header.token ||
    !path.isAbsolute(ticket.control) ||
    path.normalize(ticket.control) !== ticket.control ||
    !path.isAbsolute(ticket.image.executable)
  )
    throw new Error("Source native ticket binding invalid")
  return Object.freeze({
    ...ticket,
    header: Object.freeze({
      ...ticket.header,
      roots: Object.freeze(ticket.header.roots.map((value) => Object.freeze(value))),
      ...(ticket.header.policy
        ? {
            policy: Object.freeze({
              ...ticket.header.policy,
              directories: Object.freeze([...ticket.header.policy.directories]),
              files: Object.freeze([...ticket.header.policy.files]),
            }),
          }
        : {}),
    }),
    image: Object.freeze(ticket.image),
  })
}

async function action(ticket: Ticket, value: 1 | 2 | 3) {
  await verified(ticket)
  await owned(ticket.header.helper, ticket.header.helperBirth, ticket.image.executable)
  await publish(
    `${ticket.control}.source-${value === 1 ? "go" : value === 2 ? "capture" : "abort"}`,
    packet(1, ticket.token, value, ticket.header.pid, ticket.header.birth),
    ticket.image.executable,
  )
  if (value === 2) {
    const saved = header
      .extend({ state: z.literal("capture-ready") })
      .parse(await wait(`${ticket.control}.source-capture-ready`, 15000, ticket.image.executable))
    const { state: _state, ...actual } = saved
    const { state: _initial, ...expected } = ticket.header
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error("Source capture acceptance identity changed")
  }
}

export async function launch(input: {
  executable: string
  digest: string
  cwd: string
  args: readonly string[]
  env: Record<string, string>
  roots: readonly { kind: "json" | "sqlite"; path: string }[]
  helper?: { executable: string; digest: string }
  policy?: SourcePolicy
  timeout?: number
  stdio?: "pipe" | "inherit"
}) {
  const command = await canonical(input.executable)
  const cwd = await canonical(input.cwd)
  const selected = await roots(input.roots)
  const policy = input.policy ? await validatePolicy(input.policy) : undefined
  if (policy && selected.some((root) => !covers(policy, root.path)))
    throw new Error("Source seed roots are outside producer policy")
  const timeout = input.timeout ?? 30000
  if (
    !same(command, input.executable) ||
    !same(cwd, input.cwd) ||
    !(await stat(cwd)).isDirectory() ||
    !digest.safeParse(input.digest).success ||
    (await sum(command)) !== input.digest ||
    input.args.length > 128 ||
    !Number.isSafeInteger(timeout) ||
    timeout < 100 ||
    timeout > 60000 ||
    !selected.length ||
    selected.length > 64
  )
    throw new Error("Source launcher trusted target invalid")
  const directory = await mkdtemp(path.join(os.tmpdir(), "raya-native-source-"))
  const control = path.join(await canonical(directory), "owner")
  const token = randomUUID()
  const executable = await NativeProcess.source(input.helper?.executable)
  if (policy) await NativeProcess.policy(executable)
  const checksum = await sum(executable)
  if (
    input.helper &&
    (!same(await canonical(input.helper.executable), input.helper.executable) || checksum !== input.helper.digest)
  )
    throw new Error("Source helper pinned image changed")
  const parent = z
    .object({ status: z.literal("owned"), birth, parent: z.number().int().nonnegative() })
    .strict()
    .parse(await NativeProcess.inspect(process.pid, executable))
  const frame = packet(
    policy ? 2 : 1,
    timeout,
    command,
    input.digest,
    cwd,
    input.args.length,
    ...input.args,
    selected.length,
    ...selected.flatMap((value) => [value.kind === "json" ? 0 : 1, value.path]),
    ...(policy
      ? [
          1,
          policy.directories.length,
          ...policy.directories,
          policy.files.length,
          ...policy.files,
          hash(JSON.stringify(policy)),
        ]
      : []),
  )
  if (frame.length > 24576) throw new Error("Source native launch envelope exceeded bound")
  const options = {
    cwd,
    env: {
      ...input.env,
      RAYA_SOURCE_JOB_CONTROL: control,
      RAYA_SOURCE_JOB_TOKEN: token,
      RAYA_SOURCE_JOB_HELPER: executable,
      RAYA_SOURCE_JOB_DIGEST: checksum,
      RAYA_SOURCE_LAUNCH: frame.toString("base64"),
    },
    windowsHide: input.stdio !== "inherit",
  }
  const argv = ["source-launch", String(process.pid), parent.birth, control, token]
  const child =
    input.stdio === "inherit"
      ? spawn(executable, argv, { ...options, stdio: [0, 1, 2] })
      : spawn(executable, argv, { ...options, stdio: ["ignore", "pipe", "pipe"] })
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
  const close = new Promise<void>((resolve) => child.once("close", () => resolve()))
  const owner = Object.freeze({ child, exit, close })
  const streams = [child.stdout, child.stderr]
  void exit.catch(() => undefined)
  const ticket = await (async () => {
    try {
      const actual = header.parse(await wait(`${control}.source-launch`, 15000, executable))
      const ticket = parseTicket({
        format: "raya.source-job",
        version: 1,
        control,
        token,
        header: actual,
        image: { executable, digest: checksum },
      })
      if (
        actual.helper !== child.pid ||
        actual.digest !== input.digest ||
        !same(actual.executable, command) ||
        JSON.stringify(actual.roots) !==
          JSON.stringify(selected.map((value) => ({ kind: value.kind, path: value.path.toLowerCase() })))
      )
        throw new Error(`Source suspended identity differs; retained at ${directory}`)
      await owned(actual.pid, actual.birth, executable)
      await owned(actual.helper, actual.helperBirth, executable)
      return ticket
    } catch (primary) {
      const results = await Promise.allSettled([owner.exit, owner.close, ...streams.map(drain)] as const)
      const result = results[0]
      const exit = result.status === "fulfilled" ? result.value : null
      const failures = results.flatMap((value) => (value.status === "rejected" ? [value.reason] : []))
      if (exit && (exit.code !== 0 || exit.signal))
        failures.push(new Error("Source pre-Go helper exited without natural retirement"))
      throw new LaunchFailure(
        primary,
        failures,
        Object.freeze({
          exit,
          originalExitJoined: result.status === "fulfilled",
          originalCloseJoined: results[1].status === "fulfilled",
          originalStreamsJoined:
            streams.every((value) => value !== null) && results.slice(2).every((value) => value.status === "fulfilled"),
          ordinaryRetirement: false,
          portableCaptureAuthorized: false,
          forced: "unknown",
        }),
      )
    }
  })()
  const state = {
    started: undefined as Promise<void> | undefined,
    closing: undefined as Promise<void> | undefined,
    retired: undefined as ReturnType<typeof retirement> | undefined,
    handoff: undefined as Promise<Handoff> | undefined,
    request: undefined as string | undefined,
    successor: undefined as Promise<z.infer<typeof IdentitySchema>> | undefined,
    successorID: undefined as string | undefined,
  }
  const sourceExit = rootExit(ticket, exit)
  void sourceExit.catch(() => undefined)
  return Object.freeze({
    ticket,
    child,
    exit,
    sourceExit,
    start: () => (state.started ??= action(ticket, 1)),
    broker: (value: Broker) => {
      if (state.closing) return Promise.reject(new Error("Source broker intake is closed"))
      return broker(ticket, value)
    },
    successor: (id: string) => {
      uuid.parse(id)
      if (state.successorID && state.successorID !== id)
        return Promise.reject(new Error("Source successor observation changed after acceptance"))
      state.successorID = id
      return (state.successor ??= (async () => {
        const value = await successor(ticket, id)
        const receiver = Object.freeze({
          pid: value.pid,
          birth: value.birth,
          executable: ticket.header.executable,
          digest: ticket.header.digest,
        })
        const handoff = await readHandoff(ticket)
        if (handoff) {
          if (handoff.id !== id) throw new Error("Source successor observation request differs")
          const value = observation.parse({
            version: 1,
            id,
            token: ticket.token,
            request: signature(ticket, handoff),
            receiver,
          })
          await publish(
            `${ticket.control}.source-producer-observed`,
            Buffer.from(JSON.stringify({ observation: value, signature: observed(ticket, value) })),
            ticket.image.executable,
          )
        }
        return receiver
      })())
    },
    capture: () => (state.closing ??= action(ticket, 2)),
    handoff: (value: { id: string; pipe: Descriptor; purpose?: "export" }) => {
      if (state.closing) return Promise.reject(new Error("Source handoff intake is closed"))
      const input = z
        .object({ id: uuid, pipe: DescriptorSchema, purpose: z.literal("export").optional() })
        .strict()
        .parse(value)
      const signature = JSON.stringify(input)
      if (state.request && state.request !== signature)
        return Promise.reject(new Error("Source handoff request changed after acceptance"))
      state.request = signature
      return (state.handoff ??= handoff(ticket, input))
    },
    abort: async () => {
      state.closing ??= Promise.resolve()
      await action(ticket, 3)
      const result = await exit
      if (result.signal) throw new Error("Source helper abort exit remained unconfirmed")
      return Object.freeze({ forced: true as const, code: result.code, portableCaptureAuthorized: false as const })
    },
    retired: () =>
      (state.retired ??= (async () => {
        const result = await exit
        if (result.code !== 0 || result.signal) throw new Error("Source native helper did not retire naturally")
        return retirement(ticket)
      })()),
  })
}

export type Broker = {
  expected: { executable: string; digest: string }
  request: string
  directory: string
  args: readonly string[]
  env: Record<string, string>
}
async function broker(ticket: Ticket, input: Broker) {
  const actual = await verified(ticket)
  await owned(actual.helper, actual.helperBirth, ticket.image.executable)
  if (
    !uuid.safeParse(input.request).success ||
    !same(input.expected.executable, actual.executable) ||
    input.expected.digest !== actual.digest ||
    input.args.length < 1 ||
    input.args.length > 128
  )
    throw new Error("Source successor broker identity differs")
  if ((await NativeProcess.receipt(`${ticket.control}.source-capture`, ticket.image.executable)) !== undefined)
    throw new Error("Source successor broker intake is closed")
  const directory = await canonical(input.directory)
  if (!same(directory, input.directory)) throw new Error("Source successor directory changed")
  const env = Object.entries(input.env)
  if (!env.length || env.length > 256) throw new Error("Source successor environment exceeded bound")
  await publish(
    `${ticket.control}.source-broker`,
    packet(
      1,
      ticket.token,
      input.request,
      actual.executable,
      directory,
      input.args.length,
      ...input.args,
      env.length,
      ...env.flat(),
    ),
    ticket.image.executable,
  )
  return successor(ticket, input.request)
}
async function successor(ticket: Ticket, id: string) {
  uuid.parse(id)
  await verified(ticket)
  const end = performance.now() + 15000
  while (performance.now() < end) {
    if ((await read(`${ticket.control}.source-broker.refused`, ticket.image.executable, true)) !== undefined)
      throw new Error(`Source successor broker refused; retained at ${ticket.control}`)
    const value = await read(`${ticket.control}.source-broker-launched`, ticket.image.executable, true)
    if (value !== undefined) {
      const parsed = z
        .object({
          version: z.literal(1),
          token: z.literal(ticket.token),
          request: z.literal(id),
          pid,
          birth,
          outsideJob: z.literal(true),
        })
        .strict()
        .parse(value)
      const current = z
        .object({ status: z.literal("owned"), birth, parent: pid })
        .strict()
        .parse(await NativeProcess.inspect(parsed.pid, ticket.image.executable))
      if (current.birth !== parsed.birth || current.parent !== ticket.header.helper)
        throw new Error("Source successor kernel identity changed")
      const membership = header
        .extend({ state: z.literal("membership"), job: z.number().int().positive().safe() })
        .strict()
        .parse(await read(`${ticket.control}.source-membership`, ticket.image.executable))
      const { state: _state, job, ...saved } = membership
      const { state: _initial, ...expected } = ticket.header
      if (JSON.stringify(saved) !== JSON.stringify(expected)) throw new Error("Source successor Job identity changed")
      const receiver = z
        .object({ receiver: z.literal(true), pid, birth })
        .strict()
        .parse(
          await NativeProcess.receiver({
            source: {
              pid: ticket.header.pid,
              birth: ticket.header.birth,
              executable: ticket.header.executable,
              digest: ticket.header.digest,
            },
            helper: { pid: ticket.header.helper, birth: ticket.header.helperBirth, ...ticket.image },
            job,
            pid: parsed.pid,
            birth: parsed.birth,
          }),
        )
      if (receiver.pid !== parsed.pid || receiver.birth !== parsed.birth)
        throw new Error("Source successor native receiver differs")
      return Object.freeze(parsed)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Source successor broker READY timed out; retained at ${ticket.control}`)
}

async function inherited(): Promise<Ticket | undefined> {
  const control = process.env.RAYA_SOURCE_JOB_CONTROL
  const token = process.env.RAYA_SOURCE_JOB_TOKEN
  if (!control && !token) return undefined
  if (!control || !token) throw new Error("Source native context incomplete")
  const executable = await NativeProcess.source(process.env.RAYA_SOURCE_JOB_HELPER)
  const checksum = await sum(executable)
  if (process.env.RAYA_SOURCE_JOB_DIGEST && checksum !== process.env.RAYA_SOURCE_JOB_DIGEST)
    throw new Error("Source inherited helper pin changed")
  const ticket = parseTicket({
    format: "raya.source-job",
    version: 1,
    control,
    token,
    header: await read(`${control}.source-launch`, executable),
    image: { executable, digest: checksum },
  })
  const actual = await verified(ticket)
  if (actual.token !== token) throw new Error("Source inherited token changed")
  return ticket
}
/** Listener-only lookup: valid inherited descendant context grants no root authority. */
export async function handoffContext(): Promise<Ticket | undefined> {
  const ticket = await inherited()
  if (!ticket || ticket.header.pid !== process.pid) return undefined
  return context()
}
/** Original sealed Job membership is verified natively; inherited env alone grants nothing. */
export async function memberContext(): Promise<Ticket | undefined> {
  const ticket = await inherited()
  if (!ticket) return undefined
  if (
    !same(await canonical(process.execPath), ticket.header.executable) ||
    (await sum(process.execPath)) !== ticket.header.digest
  )
    throw new Error("Source member executable pin changed")
  const value = header
    .extend({ state: z.literal("membership"), job: z.number().int().positive().safe() })
    .strict()
    .parse(await read(`${ticket.control}.source-membership`, ticket.image.executable))
  const { state: _state, job, ...saved } = value
  const { state: _initial, ...expected } = ticket.header
  if (JSON.stringify(saved) !== JSON.stringify(expected)) throw new Error("Source membership guardian identity changed")
  const current = z
    .object({ status: z.literal("owned"), birth, parent: z.number().int().nonnegative() })
    .strict()
    .parse(await NativeProcess.inspect(process.pid, ticket.image.executable))
  const result = z
    .object({ member: z.literal(true), pid, birth })
    .strict()
    .parse(
      await NativeProcess.member({
        source: {
          pid: ticket.header.pid,
          birth: ticket.header.birth,
          executable: ticket.header.executable,
          digest: ticket.header.digest,
        },
        helper: { pid: ticket.header.helper, birth: ticket.header.helperBirth, ...ticket.image },
        job,
        pid: process.pid,
        birth: current.birth,
      }),
    )
  if (result.pid !== process.pid || result.birth !== current.birth)
    throw new Error("Source membership native caller changed")
  return ticket
}
export async function context(): Promise<Ticket | undefined> {
  const ticket = await inherited()
  if (!ticket) return undefined
  const actual = ticket.header
  if (
    actual.pid !== process.pid ||
    !same(await canonical(process.execPath), actual.executable) ||
    (await sum(process.execPath)) !== actual.digest
  )
    throw new Error("Source native context does not belong to this process")
  await owned(process.pid, actual.birth, ticket.image.executable)
  return ticket
}
export async function brokerCurrent(input: Broker) {
  const ticket = await context()
  if (!ticket) throw new Error("Source is not natively contained")
  return broker(ticket, input)
}
export async function captureCurrent() {
  const ticket = await context()
  if (!ticket) throw new Error("Source is not natively contained")
  const handoff = await readHandoff(ticket)
  if (handoff) await producer(ticket, handoff)
  await action(ticket, 2)
}

const proofs = new WeakSet<object>()
async function retirement(ticket: Ticket) {
  await verified(ticket)
  const raw = await read(`${ticket.control}.source-family-retired`, ticket.image.executable)
  const value = header
    .omit({ state: true, version: true })
    .extend({
      version: z.union([z.literal(2), z.literal(3)]),
      state: z.literal("retired"),
      rootExit: z.literal(0),
      familyZeroObserved: z.literal(true),
      sealed: z.literal(true),
      capture: z.literal(true),
      forced: z.literal(false),
      memberObservationsComplete: z.boolean(),
      memberObservationsOverflow: z.boolean().optional(),
      totalProcesses: z.number().int().positive(),
      success: z.literal(true),
      members: z
        .array(z.object({ pid, birth, code: z.number().int().nonnegative().max(0xffffffff) }).strict())
        .min(1)
        .max(4096),
    })
    .strict()
    .parse(raw)
  const {
    state: _state,
    version: _version,
    rootExit: _root,
    familyZeroObserved: _zero,
    sealed: _sealed,
    capture: _capture,
    forced: _forced,
    memberObservationsComplete: _complete,
    memberObservationsOverflow: _overflow,
    totalProcesses: _total,
    success: _success,
    members,
    ...saved
  } = value
  const { state: _initial, version: _original, ...expected } = ticket.header
  if (value.version !== ticket.header.version + 1) throw new Error("Source family policy generation changed")
  if (
    JSON.stringify(saved) !== JSON.stringify(expected) ||
    new Set(members.map((member) => member.pid)).size !== members.length ||
    !members.some((member) => member.pid === ticket.header.pid && member.birth === ticket.header.birth)
  )
    throw new Error("Source native retirement identity differs")
  if (
    value.totalProcesses < members.length ||
    (value.memberObservationsComplete && value.totalProcesses !== members.length)
  )
    throw new Error("Source member observation counts changed")
  const proof = Object.freeze({
    ticket,
    familyZeroObserved: true as const,
    memberObservationsComplete: value.memberObservationsComplete,
    memberObservationsOverflow: value.memberObservationsOverflow ?? false,
    totalProcesses: value.totalProcesses,
    members: Object.freeze(members.map((member) => Object.freeze(member))),
    completeProfileCoverage: false as const,
    portableCaptureAuthorized: false as const,
  })
  proofs.add(proof)
  return proof
}

/** Attach outside the source Job before READY; never await self-retirement inside its source. */
export async function observe(raw: unknown, timeout = 60000) {
  const ticket = parseTicket(raw)
  if (ticket.header.pid === process.pid) throw new Error("Source cannot wait for its own native family retirement")
  await verified(ticket)
  await owned(ticket.header.helper, ticket.header.helperBirth, ticket.image.executable)
  const observer = watch({
    pid: ticket.header.helper,
    birth: ticket.header.helperBirth,
    executable: ticket.image.executable,
    timeout,
  })
  await observer.ready
  const done = (async () => {
    if ((await observer.done) !== 0) throw new Error("Source family helper did not exit naturally")
    return retirement(ticket)
  })()
  void done.catch(() => undefined)
  return { ready: observer.ready, done, close: observer.close }
}

/** An opaque family proof still supplies no complete profile capture authority. */
export function isRetired(value: unknown) {
  return typeof value === "object" && value !== null && proofs.has(value)
}

const request = z
  .object({
    version: z.literal(1),
    id: uuid,
    token: uuid,
    source: IdentitySchema,
    pipe: DescriptorSchema,
    purpose: z.literal("export").optional(),
  })
  .strict()
export type Handoff = z.infer<typeof request>
const signature = (ticket: Ticket, value: Handoff) =>
  createHmac("sha256", ticket.token).update(JSON.stringify(value)).digest("hex")
const observation = z
  .object({ version: z.literal(1), id: uuid, token: uuid, request: digest, receiver: IdentitySchema })
  .strict()
const observed = (ticket: Ticket, value: z.infer<typeof observation>) =>
  createHmac("sha256", ticket.token).update(JSON.stringify(value)).digest("hex")
async function producer(ticket: Ticket, handoff: Handoff) {
  const file = `${ticket.control}.source-producer-observed`
  const end = performance.now() + 15000
  while (performance.now() < end) {
    const info = await stat(file).catch((err: unknown) => {
      if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT") throw err
      return undefined
    })
    if (!info) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      continue
    }
    const envelope = z
      .object({ observation, signature: digest })
      .strict()
      .parse(await read(file, ticket.image.executable))
    const value = envelope.observation
    if (
      value.id !== handoff.id ||
      value.token !== ticket.token ||
      value.request !== signature(ticket, handoff) ||
      !timingSafeEqual(Buffer.from(envelope.signature, "hex"), Buffer.from(observed(ticket, value), "hex"))
    )
      throw new Error("Source producer observation correlation changed")
    const launched = z
      .object({
        version: z.literal(1),
        token: z.literal(ticket.token),
        request: z.literal(handoff.id),
        pid,
        birth,
        outsideJob: z.literal(true),
      })
      .strict()
      .parse(await read(`${ticket.control}.source-broker-launched`, ticket.image.executable))
    if (
      value.receiver.pid !== launched.pid ||
      value.receiver.birth !== launched.birth ||
      value.receiver.executable !== ticket.header.executable ||
      value.receiver.digest !== ticket.header.digest
    )
      throw new Error("Source producer observed a different receiver")
    return
  }
  throw new Error(`Source producer observation timed out; retained at ${ticket.control}`)
}
async function handoff(ticket: Ticket, input: { id: string; pipe: Descriptor; purpose?: "export" }): Promise<Handoff> {
  await verified(ticket)
  await owned(ticket.header.pid, ticket.header.birth, ticket.image.executable)
  const value = request.parse({
    version: 1,
    id: input.id,
    token: ticket.token,
    source: {
      pid: ticket.header.pid,
      birth: ticket.header.birth,
      executable: ticket.header.executable,
      digest: ticket.header.digest,
    },
    pipe: input.pipe,
    ...(input.purpose ? { purpose: input.purpose } : {}),
  })
  if (
    value.pipe.server.executable.toLowerCase() !== ticket.image.executable.toLowerCase() ||
    value.pipe.server.digest !== ticket.image.digest
  )
    throw new Error("Source handoff pipe helper pin changed")
  await owned(value.pipe.server.pid, value.pipe.server.birth, ticket.image.executable)
  await publish(
    `${ticket.control}.source-handoff`,
    Buffer.from(JSON.stringify({ request: value, signature: signature(ticket, value) })),
    ticket.image.executable,
  )
  return Object.freeze(value)
}
/** Authenticated metadata only: this neither starts capture nor conveys its passphrase. */
export async function readHandoff(ticket: Ticket): Promise<Handoff | undefined> {
  await verified(ticket)
  const file = `${ticket.control}.source-handoff`
  const info = await stat(file).catch((err: unknown) => {
    if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT") throw err
    return undefined
  })
  if (!info) return undefined
  const envelope = z
    .object({ request, signature: digest })
    .strict()
    .parse(await read(file, ticket.image.executable))
  const value = envelope.request
  const expected = {
    pid: ticket.header.pid,
    birth: ticket.header.birth,
    executable: ticket.header.executable,
    digest: ticket.header.digest,
  }
  if (
    value.token !== ticket.token ||
    JSON.stringify(value.source) !== JSON.stringify(expected) ||
    !timingSafeEqual(Buffer.from(envelope.signature, "hex"), Buffer.from(signature(ticket, value), "hex"))
  )
    throw new Error("Source handoff correlation changed")
  if (
    value.pipe.server.executable.toLowerCase() !== ticket.image.executable.toLowerCase() ||
    value.pipe.server.digest !== ticket.image.digest
  )
    throw new Error("Source handoff pipe server pin changed")
  return Object.freeze(value)
}

async function rootExit(ticket: Ticket, exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>) {
  const state = { exited: false }
  void exit.then(
    () => {
      state.exited = true
    },
    () => {
      state.exited = true
    },
  )
  const file = `${ticket.control}.source-root-exited`
  while (true) {
    const info = await stat(file).catch((err: unknown) => {
      if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT") throw err
      return undefined
    })
    if (info) {
      const parsed = header
        .extend({ state: z.literal("root-exited"), code: z.number().int().nonnegative().max(0xffffffff) })
        .parse(await read(file, ticket.image.executable))
      const { state: _state, code, ...saved } = parsed
      const { state: _initial, ...expected } = ticket.header
      if (JSON.stringify(saved) !== JSON.stringify(expected)) throw new Error("Source root exit identity changed")
      return Object.freeze({
        pid: parsed.pid,
        birth: parsed.birth,
        code,
        completeProfileCoverage: false as const,
        portableCaptureAuthorized: false as const,
      })
    }
    if (state.exited) throw new Error("Source helper exited without exact source-root notification")
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}
