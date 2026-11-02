import { tool } from "@kilocode/plugin"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

const locks = new Set<string>()
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const text = tool.schema.string().min(1).max(512)

function run(binary: string, args: string[], signal?: AbortSignal) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^AGENT_DESKTOP_(SESSION|AGENT_ID|TRACE|HEADED)$/i.test(key)),
    )
    execFile(
      binary,
      args,
      { windowsHide: true, signal, env, timeout: 20_000, maxBuffer: 1_048_576 },
      (_err, stdout) => {
        // Keep structured delivery refusals even when the CLI exits nonzero.
        const parsed = tool.schema
          .object({ version: tool.schema.literal("2.5"), ok: tool.schema.boolean() })
          .passthrough()
          .safeParse(
            (() => {
              try {
                return JSON.parse(stdout)
              } catch {
                return undefined
              }
            })(),
          )
        if (parsed.success) return resolve(parsed.data)
        reject(
          new Error(
            "Background desktop result is unknown because the CLI response is missing or invalid; inspect before retrying",
          ),
        )
      },
    )
  })
}

function refs(value: unknown, role: string, name: string): string[] {
  const node = object(value)
  const match =
    node.role === role &&
    typeof node.name === "string" &&
    node.name.toLowerCase() === name.toLowerCase() &&
    typeof node.ref_id === "string" &&
    /^@[a-zA-Z0-9_-]+:e\d+$/.test(node.ref_id)
      ? [node.ref_id]
      : []
  return [...match, ...(Array.isArray(node.children) ? node.children.flatMap((child) => refs(child, role, name)) : [])]
}

export default tool({
  description:
    "Operate an explicitly selected Windows app through Vercel's headless accessibility API. First list windows, then use its exact window ID, app and title. Snapshot before choosing an exact role/name. Supports observing, setting one field, or invoking one control; returns a fresh readback. Never uses physical input, foreground fallback, cursor overlays or screenshots. Requires existing task permission; sensitive actions still need their normal approval. A delivered action is never automatically retried. Different windows may run concurrently; this backend serializes each window. Each call owns and ends its own short-lived desktop session.",
  args: {
    action: tool.schema.enum(["windows", "snapshot", "set_value", "click"]),
    app: text.describe("Exact application name from window inventory, for example Notepad.exe"),
    window: text.optional().describe("Exact window ID from windows; required except for windows"),
    title: text.optional().describe("Exact window title from inventory; required except for windows"),
    role: tool.schema.enum(["button", "textfield", "checkbox", "menuitem", "combobox", "link"]).optional(),
    name: text.optional().describe("Exact accessible name from a snapshot; never guessed"),
    value: tool.schema.string().max(16_384).optional(),
  },
  async execute(args, ctx) {
    if (process.platform !== "win32") throw new Error("Background desktop is installed for Windows only")
    if (args.action !== "windows" && (!args.window || !args.title))
      throw new Error("Choose an exact window ID and title from inventory first")
    if ((args.action === "click" || args.action === "set_value") && (!args.role || !args.name))
      throw new Error("Choose exactly one observed role and accessible name")
    if (args.action === "set_value" && (args.role !== "textfield" || args.value === undefined))
      throw new Error("Set value requires an observed textfield and an explicit value")
    if (args.action !== "set_value" && args.value !== undefined) throw new Error("Value is only valid for set_value")
    ctx.abort.throwIfAborted()
    const root =
      process.env.RAYA_CONFIG_DIR?.trim() ||
      process.env.KILO_CONFIG_DIR?.trim() ||
      path.join(homedir(), ".config", "kilo")
    if (!path.isAbsolute(root)) throw new Error("Background desktop requires an absolute reviewed config directory")
    const cfg = object(
      JSON.parse(await readFile(path.join(root, "skills", "raya-agent-desktop", "install.json"), "utf8")),
    )
    if (
      cfg.provider !== "vercel-labs/agent-desktop" ||
      cfg.version !== "1.0.2" ||
      typeof cfg.binary !== "string" ||
      !path.isAbsolute(cfg.binary) ||
      typeof cfg.binarySHA256 !== "string"
    )
      throw new Error("Reviewed Agent Desktop installation is unavailable")
    const binary = cfg.binary
    if (
      createHash("sha256")
        .update(await readFile(binary))
        .digest("hex") !== cfg.binarySHA256
    )
      throw new Error("Agent Desktop binary differs from the reviewed installation")
    await ctx.ask({
      permission: "background_desktop",
      patterns: [`${args.app}/${args.window ?? "inventory"}/${args.action}`],
      always: [],
      metadata: {
        app: args.app,
        window: args.window,
        title: args.title,
        action: args.action,
        role: args.role,
        name: args.name,
      },
    })
    ctx.abort.throwIfAborted()
    const key = args.window ?? `inventory:${args.app}`
    if (locks.has(key)) throw new Error("This window already has a background action; wait for that action's result")
    locks.add(key)
    let session: string | undefined
    let result: Record<string, unknown> | undefined
    let failure: unknown
    let cleanup: Record<string, unknown> | undefined
    try {
      // Let bounded creation return ownership even if cancellation arrives while
      // the manifest is being written. No app action starts before the check below.
      const start = await run(binary, ["session", "start", "--no-trace"])
      const id = object(start.data).session_id
      if (start.ok !== true || typeof id !== "string") throw new Error("Background desktop session did not start")
      session = id
      ctx.abort.throwIfAborted()
      const scoped = ["--session", session, "--agent-id", ctx.sessionID.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)]
      if (args.action === "windows") {
        result = await run(binary, ["list-windows", `--app=${args.app}`, ...scoped], ctx.abort)
      }
      if (args.action !== "windows") {
        const snapshot = () =>
          run(binary, ["snapshot", `--window-id=${args.window}`, "--timeout-ms", "5000", ...scoped], ctx.abort)
        const before = await snapshot()
        const data = object(before.data)
        const window = object(data.window)
        if (
          before.ok !== true ||
          data.complete !== true ||
          window.id !== args.window ||
          window.title !== args.title ||
          data.app !== args.app
        )
          throw new Error("The selected app/window changed or its accessibility snapshot is incomplete")
        if (args.action === "snapshot") result = before
        if (args.action === "click" || args.action === "set_value") {
          const found = refs(data.tree, args.role!, args.name!)
          if (found.length !== 1)
            throw new Error(`Expected one observed control; found ${found.length}. Take a fresh snapshot`)
          const action = await run(
            binary,
            [
              args.action === "click" ? "click" : "set-value",
              ...scoped,
              "--",
              found[0],
              ...(args.action === "set_value" ? [args.value!] : []),
            ],
            ctx.abort,
          )
          // Invocation can be delivered without verification. Preserve that receipt,
          // then observe exactly once; never replay a click or field write.
          result = { action }
          result.readback = await snapshot()
        }
      }
    } catch (err) {
      failure = err
    } finally {
      // The action's aborted signal must not prevent retiring our own session.
      if (session) {
        try {
          cleanup = await run(binary, ["session", "end", session])
        } catch (err) {
          cleanup = { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
      locks.delete(key)
    }
    if (failure)
      return JSON.stringify({
        ok: false,
        error: failure instanceof Error ? failure.message : String(failure),
        result,
        cleanup,
      })
    const action = object(result?.action)
    const readback = object(result?.readback)
    const ok = cleanup?.ok === true && (result?.ok === true || (action.ok === true && readback.ok === true))
    return JSON.stringify({ ok, result, cleanup })
  },
})
