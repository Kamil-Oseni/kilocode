import { readFile, rename } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { image } from "./ownership"
import { observation } from "../cli/profile-retirement"

const Request = z
  .object({
    version: z.literal(1),
    generation: z.string().uuid(),
    request: z.string().uuid(),
    purpose: z.literal("capture").optional(),
  })
  .strict()
const state: {
  request?: z.infer<typeof Request>
  failure?: unknown
  timer?: ReturnType<typeof setInterval>
  pending?: Promise<void>
  final?: Promise<void>
  closed: boolean
} = { closed: false }

export function captureRequested() {
  return state.request?.purpose === "capture"
}

function config() {
  const generation = process.env.RAYA_DAEMON_GENERATION
  if (!generation) return undefined
  const request = process.env.RAYA_DAEMON_REQUEST
  const receipt = process.env.RAYA_DAEMON_RECEIPT
  if (
    !z.string().uuid().safeParse(generation).success ||
    !request ||
    !receipt ||
    !path.isAbsolute(request) ||
    !path.isAbsolute(receipt) ||
    path.dirname(request) !== path.dirname(receipt)
  )
    throw new Error("Daemon child controller identity is invalid")
  return { generation, request, receipt }
}

/** Only a launch-correlated request can trigger the existing joined serve shutdown. */
export function listen(run: () => Promise<void>) {
  const cfg = config()
  if (!cfg) return async () => undefined
  const poll = async () => {
    try {
      const text = await readFile(cfg.request, "utf8").catch((err: unknown) => {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined
        throw err
      })
      if (text === undefined) return
      if (text.length > 4096) throw new Error("Daemon controller request exceeded bound")
      const request = Request.parse(JSON.parse(text))
      if (request.generation !== cfg.generation) throw new Error("Daemon controller generation changed")
      state.request = request
      clearInterval(state.timer)
      void run().catch((err: unknown) => {
        state.failure = err
      })
    } catch (err) {
      state.failure = err
      clearInterval(state.timer)
      // Preserve failure and enter normal retirement; the final acknowledgment refuses success.
      void run().catch((error: unknown) => {
        state.failure = new AggregateError([err, error], "Daemon request and retirement failed")
      })
    }
  }
  state.timer = setInterval(() => {
    if (state.closed || state.pending || state.request) return
    state.pending = poll().finally(() => {
      state.pending = undefined
    })
  }, 100)
  return async () => {
    state.closed = true
    clearInterval(state.timer)
    await state.pending
  }
}

/** Called only after actual runtime/database/file-log retirement, immediately before natural exit. */
export function finalize(success: boolean): Promise<void> {
  if (state.final) return state.final
  const cfg = config()
  if (!cfg || !state.request) return Promise.resolve()
  const request = state.request
  state.final = (async () => {
    clearInterval(state.timer)
    const identity = await image(process.pid)
    const value = {
      version: 1,
      generation: cfg.generation,
      request: request.request,
      ...(request.purpose ? { purpose: request.purpose } : {}),
      pid: process.pid,
      ...identity,
      success: success && !state.failure,
      roots: observation(),
      portableCaptureAuthorized: false,
    }
    const temp = `${cfg.receipt}.${request.request}.tmp`
    await Bun.write(temp, JSON.stringify(value))
    await rename(temp, cfg.receipt)
    if (state.failure) throw new AggregateError([state.failure], "Daemon cooperative retirement failed")
  })()
  return state.final
}
