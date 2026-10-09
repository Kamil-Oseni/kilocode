import path from "node:path"
import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { spawn } from "../../util/process"
import { directory, environment, image, normalize, observe } from "../control/identity"
import { document, object, check } from "../control/frames"
import { packaged } from "../control/index"
import { publish } from "../managed/owner"
import { fingerprint } from "../failed-repair"

type Ref = { path: string; bytes: number; sha256: string }
export type Launch = {
  format: "raya.media.launch.v1"
  root: string
  dependencies: string
  python: Ref
  sources: Record<"supervisor.py" | "worker.py" | "session.py" | "library.py" | "encoder.py" | "owner.py", Ref>
}
export type Request = {
  format: "raya.media.operation.v1"
  request: string
  epoch: string
  release: string
  policySHA: string
  op: "inspect" | "import" | "index" | "search" | "forget"
  selection: {
    format: "raya.media.selection.v1"
    project: string
    source: string
    root: string
    excluded: string[]
    files: { path: string; sha256: string; bytes: number; kind: "image" | "audio" | "video"; title: string }[]
  }
  args: { id: string } | { query: string; top: number }
  model: Ref | null
}

function retirement(value: ReturnType<typeof object>, input: Request) {
  check(
    value.format === "raya.worker.ownership" &&
      value.version === 1 &&
      value.request === input.request &&
      value.owner_epoch === input.epoch &&
      value.phase === "terminal" &&
      value.cleanup_outcome === "joined" &&
      value.operation_outcome === "completed" &&
      value.root_exit === 0 &&
      value.job_active === 0 &&
      value.ownership_retained === false,
    "Original media worker family is not naturally retired",
  )
}

function admission(value: ReturnType<typeof object>) {
  const creation = object(value.creation)
  check(
    creation.succeeded === true &&
      creation.creation_time_job_list === true &&
      value.membership_observed === true &&
      value.original_process_retained === true &&
      value.original_job_retained === true &&
      value.joins_observed === true &&
      value.writer_joined === true &&
      value.writer_returned === true &&
      value.frame_written === true &&
      value.payload_written === true &&
      value.work_admitted === true,
    "Original media creation, admission and joins remain unconfirmed",
  )
}

function lineage(value: ReturnType<typeof object>, cfg: Launch, original: Awaited<ReturnType<typeof observe>>) {
  const owner = object(value.owner)
  const worker = object(value.worker)
  check(
    value.fence_unconfirmed !== true && Array.isArray(value.errors) && value.errors.length === 0,
    "Original media owner retained errors or an unconfirmed fence",
  )
  check(
    owner.pid === original.pid &&
      owner.birth_filetime === original.birth &&
      typeof owner.image === "string" &&
      normalize(owner.image) === normalize(cfg.python.path) &&
      Number.isSafeInteger(worker.pid) &&
      Number(worker.pid) > 0 &&
      worker.pid !== owner.pid &&
      typeof worker.birth_filetime === "string" &&
      /^[1-9]\d{0,19}$/.test(worker.birth_filetime) &&
      typeof worker.image === "string" &&
      normalize(worker.image) === normalize(cfg.python.path),
    "Original media native process lineage changed",
  )
}

function reader(value: ReturnType<typeof object>, name: string) {
  const stream = object(value)
  check(
    stream.eof === true &&
      stream.overflow === false &&
      Array.isArray(stream.errors) &&
      stream.errors.length === 0 &&
      Number.isSafeInteger(stream.bytes) &&
      Number(stream.bytes) >= 0 &&
      Number(stream.bytes) <= 131072,
    "Original media worker reader is unconfirmed",
  )
  if (name === "error") check(stream.bytes === 0, "Original media worker emitted diagnostics")
}

function family(
  value: ReturnType<typeof object>,
  input: Request,
  cfg: Launch,
  original: Awaited<ReturnType<typeof observe>>,
) {
  retirement(value, input)
  admission(value)
  lineage(value, cfg, original)
  const outputs = object(value.outputs)
  for (const name of ["output", "error"]) {
    reader(object(outputs[name]), name)
  }
}

async function publications(cfg: Launch, input: Request, terminal: ReturnType<typeof object>) {
  const folder = path.join(cfg.root, "Requests", input.epoch)
  await directory(folder)
  const pending = await image(path.join(folder, input.request + ".pending.json"), 131072)
  const before = object(document(pending.raw, 131072).value)
  check(
    before.format === "raya.media.pending.v1" &&
      before.requestSHA === fingerprint(input) &&
      fingerprint(before.operation) === fingerprint(input) &&
      terminal.pendingSHA === pending.digest,
    "Original media pending publication differs",
  )
  const final = await image(path.join(folder, input.request + ".terminal.json"), 131072)
  check(
    isDeepStrictEqual(document(final.raw, 131072).value, terminal),
    "Original media streamed terminal differs from its immutable publication",
  )
  return [
    {
      path: path.join(folder, input.request + ".pending.json"),
      bytes: pending.raw.length,
      sha256: pending.digest,
      tuple: pending.tuple,
    },
    {
      path: path.join(folder, input.request + ".terminal.json"),
      bytes: final.raw.length,
      sha256: final.digest,
      tuple: final.tuple,
    },
  ]
}

async function retained(ref: Ref) {
  await directory(path.dirname(ref.path))
  const value = await image(ref.path, 16777216)
  check(value.raw.length === ref.bytes && value.digest === ref.sha256, "Selected media runtime image changed")
  return value
}

function successful(
  terminal: ReturnType<typeof object> | undefined,
  ownership: ReturnType<typeof object> | undefined,
  stopped: boolean,
) {
  return (
    !stopped &&
    terminal?.accepted === true &&
    terminal.status === "completed" &&
    ownership?.observation_expired !== true
  )
}

function budget(input: Request) {
  return ["index", "search"].includes(input.op) ? 300000 : 30000
}

function details(terminal: ReturnType<typeof object> | undefined, errors: unknown[]) {
  try {
    return terminal?.ownership ? object(terminal.ownership) : undefined
  } catch (err) {
    errors.push(err)
    return undefined
  }
}

/** A caller owns the durable claim before spawning; only this original may start and join its worker. */
export async function run(
  extension: string,
  cfg: Launch,
  input: Request,
  signal: AbortSignal,
  authorize: () => Promise<void>,
  bind: (value: {
    identity: Awaited<ReturnType<typeof observe>>
    launch: Awaited<ReturnType<typeof publish>>
  }) => Promise<void>,
  duration = budget(input),
) {
  signal.throwIfAborted()
  check(
    Number.isSafeInteger(duration) && duration >= 1 && duration <= budget(input),
    "Bounded original media deadline required",
  )
  check(
    input.format === "raya.media.operation.v1" &&
      /^[a-f0-9]{32}$/.test(input.request) &&
      /^[a-f0-9]{32}$/.test(input.epoch) &&
      /^[a-f0-9]{64}$/.test(input.release) &&
      /^[a-f0-9]{64}$/.test(input.policySHA) &&
      cfg.root === input.selection.root,
    "Original media request and launch selection required",
  )
  const raw = Buffer.from(JSON.stringify(input) + "\n")
  check(raw.length <= 131072, "Media request exceeds its private stream bound")
  const refs = [cfg.python, ...Object.values(cfg.sources)]
  const before = await Promise.all(refs.map(retained))
  const folder = path.join(cfg.root, "Runs", randomUUID().replaceAll("-", ""))
  await mkdir(path.dirname(folder), { recursive: true })
  await directory(path.dirname(folder))
  await mkdir(folder)
  const launch = await publish(path.join(folder, "launch.json"), cfg)
  const helper = await packaged(extension)
  await authorize()
  signal.throwIfAborted()
  const child = spawn(
    cfg.python.path,
    ["-I", "-S", "-B", "-u", cfg.sources["supervisor.py"].path, launch.path, launch.sha256, String(duration / 1000)],
    {
      cwd: folder,
      env: environment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  )
  check(child.stdin && child.stdout && child.stderr, "Original media private streams required")
  const stdin = child.stdin
  const errors: unknown[] = []
  const counts = { stdout: 0, stderr: 0 }
  const eof = { stdout: false, stderr: false }
  const state: {
    ready: boolean
    started: boolean
    stopped: boolean
    ended: boolean
    terminal?: ReturnType<typeof object>
  } = {
    ready: false,
    started: false,
    stopped: false,
    ended: false,
  }
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }))
    child.once("close", (code, signal) => {
      if (!child.pid) resolve({ code, signal })
    })
  })
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
  child.on("error", (err) => errors.push(err))
  stdin.on("error", (err) => errors.push(err))
  const writes: Promise<void>[] = []
  const write = (value: object | Buffer) => {
    const work = new Promise<void>((resolve) =>
      stdin.write(Buffer.isBuffer(value) ? value : JSON.stringify(value) + "\n", (err) => {
        if (err) errors.push(err)
        resolve()
      }),
    )
    writes.push(work)
    return work
  }
  const stop = () => {
    if (state.ended || state.stopped) return
    state.stopped = true
    if (!state.started) {
      stdin.end()
      return
    }
    void write({ format: "raya.media.stop.v1", request: input.request, epoch: input.epoch }).then(() => stdin.end())
  }
  const identity = observe(child, cfg.python.path, helper.helper, cfg.python.sha256)
    .then(async (value) => {
      await bind({ identity: value, launch })
      return value
    })
    .catch((err: unknown) => {
      errors.push(err)
      stop()
    })
  const start = async () => {
    await identity
    if (errors.length || signal.aborted || state.stopped) {
      stop()
      return
    }
    await authorize()
    await Promise.all(
      refs.map(async (ref, index) => {
        check(isDeepStrictEqual(await retained(ref), before[index]), "Media runtime changed before START")
      }),
    )
    signal.throwIfAborted()
    check(!state.stopped, "Original media START admission closed")
    state.started = true
    await write({
      format: "raya.media.start.v1",
      request: input.request,
      epoch: input.epoch,
      release: input.release,
      policySHA: input.policySHA,
    })
  }
  const handlers: Promise<void>[] = []
  const frame = (raw: Buffer) => {
    const value = object(document(raw, 131072).value)
    if (value.format === "raya.media.ready.v1") {
      check(
        !state.ready &&
          !state.terminal &&
          isDeepStrictEqual(
            { ...value },
            {
              format: "raya.media.ready.v1",
              request: input.request,
              epoch: input.epoch,
              release: input.release,
              policySHA: input.policySHA,
            },
          ),
        "Media READY belongs to a different original request",
      )
      state.ready = true
      handlers.push(
        start().catch((err: unknown) => {
          errors.push(err)
          stop()
        }),
      )
      return
    }
    check(
      state.ready && state.started && !state.terminal && value.format === "raya.media.terminal.v1",
      "Unexpected original media terminal",
    )
    check(
      ["request", "epoch", "release", "policySHA", "op"].every((key) => value[key] === input[key as keyof Request]),
      "Media terminal identity changed",
    )
    state.terminal = value
  }
  const readers = (["stdout", "stderr"] as const).map(
    (name) =>
      new Promise<void>((resolve) => {
        const stream = child[name]!
        let buffer = Buffer.alloc(0)
        stream.on("error", (err) => errors.push(err))
        stream.on("data", (raw: Buffer) => {
          counts[name] += raw.length
          if (counts[name] > 262144) {
            errors.push(new Error("Original media stream exceeds its bound"))
            stop()
            return
          }
          if (name === "stderr") {
            errors.push(new Error("Original media supervisor emitted diagnostics"))
            stop()
            return
          }
          buffer = Buffer.concat([buffer, raw])
          if (buffer.length > 131073 && !buffer.includes(10)) {
            buffer = Buffer.alloc(0)
            errors.push(new Error("Original media frame exceeds its bound"))
            stop()
            return
          }
          while (buffer.includes(10)) {
            const index = buffer.indexOf(10)
            const line = buffer.subarray(0, index)
            buffer = buffer.subarray(index + 1)
            try {
              frame(line)
            } catch (err) {
              errors.push(err)
              stop()
            }
          }
        })
        stream.once("end", () => {
          eof[name] = true
          if (name === "stdout" && buffer.length) errors.push(new Error("Original media frame did not finish"))
        })
        stream.once("close", () => resolve())
      }),
  )
  signal.addEventListener("abort", stop, { once: true })
  const timer = setTimeout(() => {
    errors.push(new Error("Media acceptance deadline expired; original lifetime remains held"))
    stop()
  }, duration + 75000)
  void write(raw)
  if (signal.aborted) stop()
  const [result, , original] = await Promise.all([exit, closed, identity, ...readers])
  state.ended = true
  await Promise.all([...handlers, ...writes])
  clearTimeout(timer)
  signal.removeEventListener("abort", stop)
  const terminal = state.terminal
  const ownership = details(terminal, errors)
  const evidence = await (async () => {
    check(
      original && terminal && ownership && state.started,
      "Original media admission or terminal remains unconfirmed",
    )
    check(
      result.code === 0 && result.signal === null && eof.stdout && eof.stderr && counts.stderr === 0 && stdin.destroyed,
      "Original media supervisor and streams remain unjoined",
    )
    check(
      terminal.authority === false && terminal.replay === false && terminal.forced === false,
      "Media terminal gained authority",
    )
    family(ownership, input, cfg, original)
    return publications(cfg, input, terminal)
  })().catch((err: unknown) => {
    errors.push(err)
    return []
  })
  if (!successful(terminal, ownership, state.stopped))
    errors.push(new Error("Original media operation is unsuccessful or uncertain"))
  const receipt = await publish(path.join(folder, "closed.json"), {
    format: "raya.media.original.closed.v1",
    launch,
    original: child.pid,
    exit: result,
    eof,
    counts,
    identity: original ?? null,
    originalJoined: true,
    readersJoined: true,
    writerJoined: true,
    forced: false,
    family: ownership ?? null,
    familyJoined: evidence.length === 2,
    evidence,
    requestSettlement: false,
    replay: false,
  })
  if (errors.length || !terminal)
    throw Object.assign(new AggregateError(errors, "Original media result or family retirement remains unconfirmed"), {
      receipt,
      terminal,
    })
  await (async () => {
    await authorize()
    signal.throwIfAborted()
    await Promise.all(
      refs.map(async (ref, index) => {
        check(isDeepStrictEqual(await retained(ref), before[index]), "Media runtime changed before original settlement")
      }),
    )
    await Promise.all(
      evidence.map(async (ref) => {
        const value = await image(ref.path, 131072)
        check(
          value.digest === ref.sha256 && value.raw.length === ref.bytes && value.tuple === ref.tuple,
          "Original media publication changed before consumption",
        )
      }),
    )
  })().catch((err: unknown) => {
    throw Object.assign(new AggregateError([err], "Original media final authorization or publications changed"), {
      receipt,
      terminal,
    })
  })
  return { terminal, receipt }
}
