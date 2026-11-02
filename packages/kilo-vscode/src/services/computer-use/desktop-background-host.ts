import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { isAbsolute } from "node:path"

type Record = { [key: string]: unknown }
type Control = { role: string; name: string; ref: string; automationID?: string }
type Target = { windowID: string; identity: string }
type Owner = { pid: number; instance: string }
type Request =
  | { action: "snapshot"; target: Target }
  | { action: "click"; target: Target; role: string; name: string }
  | { action: "set_value"; target: Target; role: "textfield"; name: string; value: string }
type Hooks = {
  // With provider evidence, the bridge must also compare its native HWND owner.
  // Hosted-frame PID disagreement refuses; it must not be resolved by title.
  verify(target: Target, owner?: Owner): Promise<void>
  authorize(action: "observe" | "pointer" | "keyboard", control?: Control): Promise<void>
  dispatch(): Promise<void>
}

function object(value: unknown): Record {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Background desktop response is not an object")
  return value as Record
}

function window(target: Target) {
  if (!/^0x[1-9A-F][0-9A-F]{0,15}$/.test(target.windowID) || !/^[A-F0-9]{64}$/.test(target.identity))
    throw new Error("Background desktop needs an exact native window binding")
  return `w-${BigInt(target.windowID)}`
}

function controls(value: unknown, role: string, name: string): Control[] {
  const node = object(value)
  const native = node.native_id && typeof node.native_id === "object" ? object(node.native_id) : undefined
  const automationID = native?.kind === "automation_id" && typeof native.value === "string" ? native.value : undefined
  const found =
    node.role === role &&
    node.name === name &&
    typeof node.ref_id === "string" &&
    /^@[a-zA-Z0-9_-]+:e\d+$/.test(node.ref_id)
      ? [{ role, name, ref: node.ref_id, automationID }]
      : []
  return [
    ...found,
    ...(Array.isArray(node.children) ? node.children.flatMap((node) => controls(node, role, name)) : []),
  ]
}

function clean(reply: Record) {
  if (reply.ok !== true || !reply.transport || typeof reply.transport !== "object" || Array.isArray(reply.transport))
    return false
  const transport = object(reply.transport)
  return transport.code === 0 && transport.interrupted === false
}

function validate(request: Request) {
  if (request.action === "snapshot") return
  if (
    !request.name ||
    request.name.length > 512 ||
    !["button", "textfield", "checkbox", "menuitem", "combobox", "link"].includes(request.role)
  )
    throw new Error("Background desktop action needs an observed control")
  if (request.action === "set_value" && (request.role !== "textfield" || request.value.length > 16_384))
    throw new Error("Background desktop field value is invalid")
}

function success(result: Record | undefined, cleanup: Record | undefined, failure: string | undefined) {
  if (failure || !cleanup || !clean(cleanup) || !result) return false
  if (result.ok === true) return clean(result)
  return !!result.action && clean(object(result.action)) && !!result.readback && clean(object(result.readback))
}

/** An extension-owned provider; the Desktop bridge supplies grant and identity checks. */
export class DesktopBackgroundHost {
  private readonly locks = new Set<string>()

  constructor(private readonly manifest: string) {
    if (!isAbsolute(manifest)) throw new Error("Background desktop installation manifest must be absolute")
  }

  async execute(input: Request, hooks: Hooks, signal: AbortSignal) {
    const request = Object.freeze({ ...input, target: Object.freeze({ ...input.target }) })
    const target = request.target
    const id = window(target)
    validate(request)
    signal.throwIfAborted()
    if (this.locks.has(id)) throw new Error("The selected window already has an active background request")
    this.locks.add(id)
    let session: string | undefined
    let result: Record | undefined
    let cleanup: Record | undefined
    let failure: string | undefined
    let attempted = false
    let started = false
    try {
      const binary = await this.binary()
      await hooks.authorize("observe")
      await hooks.verify(target)
      signal.throwIfAborted()
      // Creation must return session ownership before cancellation can discard it.
      started = true
      const start = await this.run(binary, ["session", "start", "--no-trace"])
      const owned = object(start.data).session_id
      if (typeof owned !== "string" || !/^run-[a-zA-Z0-9_-]+$/.test(owned))
        throw new Error("Background desktop session ownership was not established")
      session = owned
      const scoped = ["--session", session]
      const owner = async () => {
        const reply = await this.run(binary, ["list-windows", ...scoped], signal)
        const windows = reply.data
        if (!clean(reply) || !Array.isArray(windows)) throw new Error("Background window inventory is unavailable")
        const found = windows.map(object).filter((item) => item.id === id)
        if (found.length !== 1)
          throw new Error("The selected window is not available in the background desktop inventory")
        const pid = found[0]?.pid
        const instance = found[0]?.process_instance
        if (
          typeof pid !== "number" ||
          !Number.isSafeInteger(pid) ||
          pid < 1 ||
          pid > 0xffffffff ||
          typeof instance !== "string" ||
          !/^windows-proc-v1:\d+:\d+$/.test(instance)
        )
          throw new Error("The background window lacks exact process-generation evidence")
        const evidence = { pid, instance }
        await hooks.verify(target, evidence)
        signal.throwIfAborted()
        return evidence
      }
      const snapshot = async () => {
        signal.throwIfAborted()
        await hooks.authorize("observe")
        await hooks.verify(target)
        signal.throwIfAborted()
        const evidence = await owner()
        const reply = await this.run(
          binary,
          ["snapshot", `--window-id=${id}`, "--timeout-ms", "5000", ...scoped],
          signal,
        )
        const data = object(reply.data)
        if (!clean(reply) || data.complete !== true || object(data.window).id !== id)
          throw new Error("Selected background window is unavailable or its snapshot is incomplete")
        await hooks.verify(target, evidence)
        signal.throwIfAborted()
        return { reply, evidence }
      }
      try {
        if (!clean(start)) throw new Error("Background desktop session did not start cleanly")
        const before = await snapshot()
        if (request.action === "snapshot") result = before.reply
        if (request.action !== "snapshot") {
          const found = controls(object(before.reply.data).tree, request.role, request.name)
          if (found.length !== 1) throw new Error("Background action requires one exact observed control")
          const actual = await owner()
          if (actual.pid !== before.evidence.pid || actual.instance !== before.evidence.instance)
            throw new Error("Background window process changed after observing the control")
          await hooks.authorize(request.action === "click" ? "pointer" : "keyboard", found[0])
          await hooks.verify(target, actual)
          signal.throwIfAborted()
          await hooks.dispatch()
          attempted = true
          // Never retry an invocation, including when delivery/readback is uncertain.
          const action = await this.run(
            binary,
            [
              request.action === "click" ? "click" : "set-value",
              ...scoped,
              "--",
              found[0].ref,
              ...(request.action === "set_value" ? [request.value] : []),
            ],
            signal,
          )
          result = { action }
          result.readback = (await snapshot()).reply
        }
      } finally {
        // Independent cleanup cannot inherit an aborted action signal.
        try {
          cleanup = await this.run(binary, ["session", "end", session])
        } catch (err) {
          cleanup = { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err)
    } finally {
      this.locks.delete(id)
    }
    return {
      ok: success(result, cleanup, failure),
      drained: !started || (!!cleanup && clean(cleanup)),
      attempted,
      result,
      cleanup,
      failure,
    }
  }

  private async binary() {
    const cfg = object(JSON.parse(await readFile(this.manifest, "utf8")))
    if (
      cfg.provider !== "vercel-labs/agent-desktop" ||
      cfg.version !== "1.0.2" ||
      typeof cfg.binary !== "string" ||
      !isAbsolute(cfg.binary) ||
      typeof cfg.binarySHA256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(cfg.binarySHA256)
    )
      throw new Error("Reviewed background desktop installation is unavailable")
    if (
      createHash("sha256")
        .update(await readFile(cfg.binary))
        .digest("hex") !== cfg.binarySHA256
    )
      throw new Error("Background desktop binary differs from its reviewed installation")
    return cfg.binary
  }

  private run(binary: string, args: string[], signal?: AbortSignal): Promise<Record> {
    return new Promise((resolve, reject) => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !/^AGENT_DESKTOP_(SESSION|AGENT_ID|TRACE|HEADED)$/i.test(key)),
      )
      let reply: Record | undefined
      let failure: unknown
      let callback = false
      let closed = false
      let code: number | null = null
      let interrupted = false
      const settle = () => {
        if (!closed || !callback) return
        if (failure) return reject(failure)
        resolve({ ...reply!, transport: { code, interrupted: interrupted || signal?.aborted === true } })
      }
      const child = execFile(
        binary,
        args,
        { windowsHide: true, signal, env, timeout: 20_000, maxBuffer: 1_048_576 },
        (err, stdout) => {
          try {
            const parsed = object(JSON.parse(stdout))
            if (parsed.version !== "2.5" || typeof parsed.ok !== "boolean")
              throw new Error("Background desktop delivery is unknown; inspect the target before retrying")
            reply = parsed
            interrupted = err?.killed === true
          } catch (err) {
            failure = new Error(
              "Background desktop response is unavailable or invalid; delivery is unknown, inspect before retrying",
              { cause: err },
            )
          }
          callback = true
          settle()
        },
      )
      // An AbortError callback can precede process exit. Join close and streams too.
      child.once("close", (exit) => {
        code = exit
        closed = true
        settle()
      })
    })
  }
}
