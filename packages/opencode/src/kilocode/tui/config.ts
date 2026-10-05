import path from "path"
import { mkdir } from "node:fs/promises"
import z from "zod"
import { Effect, Layer, Schema } from "effect"
import { applyEdits, modify } from "jsonc-parser"
import { mergeDeep } from "remeda"
import { Global } from "@opencode-ai/core/global"
import { ConfigParse } from "@/config/parse"
import { CurrentWorkingDirectory } from "@/config/tui-cwd"
import { TuiConfig } from "@/config/tui"
import { KilocodeKeybinds } from "./keybinds"
import { Filesystem } from "@/util/filesystem"
import { isRecord } from "@/util/record"
import { GlobalBus } from "@/bus/global"
import { Event } from "@/server/event"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { AppRuntime } from "@/effect/app-runtime"
import { acquireProfileRoot, resolveProfileRoot } from "@opencode-ai/core/kilocode/profile-maintenance"
import { registerProcessProfile } from "@opencode-ai/core/kilocode/process-profile"
import { KiloShutdown } from "@/kilocode/cli/shutdown"

export namespace KilocodeTuiConfig {
  export const Scope = z.enum(["project", "global"])
  export type Scope = z.infer<typeof Scope>

  export const Patch = TuiConfig.Info
  export type Patch = Schema.Schema.Type<typeof Patch>
  export type Editable = Omit<Patch, "keybinds"> & { keybinds?: Record<string, string> }

  const files = ["tui.jsonc", "tui.json"] as const
  const dirs = [".kilo", ".kilocode"] as const
  const pending = new Set<Promise<void>>()
  const failures: unknown[] = []
  let tail = Promise.resolve()
  let closing: Promise<void> | undefined

  KiloShutdown.register(() => {
    if (closing) return closing
    closing = Promise.all(pending).then(() => {
      if (failures.length) throw new AggregateError(failures, "TUI config retirement failed")
    })
    return closing
  })

  export async function get(input: { directory: string }) {
    const cfg = await AppRuntime.runPromise(
      TuiConfig.Service.use((svc) => svc.info()).pipe(
        Effect.provide(
          AppNodeBuilder.build(TuiConfig.node).pipe(
            Layer.provide(Layer.succeed(CurrentWorkingDirectory, input.directory)),
          ),
        ),
      ),
    )
    return writable(cfg)
  }

  export function update(input: { directory: string; worktree?: string; scope: Scope; patch: Patch }) {
    if (closing) return Promise.reject(new Error("TUI config is retired"))
    const cfg = { ...input, patch: structuredClone(input.patch) }
    const work = tail.then(async () => {
      const selected = path.resolve(
        cfg.scope === "global"
          ? Global.Path.config
          : cfg.worktree && cfg.worktree !== "/"
            ? cfg.worktree
            : cfg.directory,
      )
      const file = path.resolve(await target(cfg))
      const dir = path.dirname(file)
      const paths = [selected, dir, file]
      const roots = await Promise.all(paths.map((path) => resolveProfileRoot({ kind: "json", path })))
      const expected = path.join(roots[1].path, path.basename(file))
      const normalize = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value)
      if (normalize(roots[2].path) !== normalize(expected))
        throw new Error("TUI config target is outside its admitted directory")
      const scopes = [...new Map(roots.map((root) => [root.id, root])).values()]
      scopes.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      const leases: Awaited<ReturnType<typeof acquireProfileRoot>>[] = []
      const errors: unknown[] = []
      let result: Editable | undefined
      async function check() {
        const current = await Promise.all(paths.map((path) => resolveProfileRoot({ kind: "json", path })))
        const chosen = await resolveProfileRoot({ kind: "json", path: path.resolve(await target(cfg)) })
        if (current.some((root, index) => root.id !== roots[index].id) || chosen.id !== roots[2].id)
          throw new Error("TUI config target changed during update")
      }
      try {
        for (const root of scopes) {
          const lease = await acquireProfileRoot(root)
          leases.push(lease)
          if (lease.id !== root.id) throw new Error("TUI config scope changed during admission")
        }
        await check()
        registerProcessProfile(scopes.map((root) => root.path))
        await mkdir(roots[1].path, { recursive: true })
        await check()
        const source = await read(roots[2].path)
        const before = source ?? "{}"
        const existing = parse(before, roots[2].path)
        const next = merge(existing, cfg.patch)
        const output = file.endsWith(".jsonc") ? patchJsonc(before, next) : JSON.stringify(next, null, 2)
        await check()
        await Filesystem.write(roots[2].path, output)
        await check()
        // Notify connected TUIs while the admitted publication and reload remain owned.
        GlobalBus.emit("event", {
          directory: "global",
          payload: { type: Event.ConfigUpdated.type, properties: {} },
        })
        result = await get({ directory: cfg.directory })
        await check()
      } catch (err) {
        errors.push(err)
      } finally {
        for (const lease of leases.reverse()) {
          try {
            await lease.release()
          } catch (err) {
            errors.push(err)
          }
        }
      }
      if (errors.length) throw new AggregateError(errors, "TUI config update failed")
      if (!result) throw new Error("TUI config reload did not return settings")
      return result
    })
    const settled = work.then(
      () => {
        pending.delete(settled)
      },
      (err) => {
        failures.push(err)
        pending.delete(settled)
      },
    )
    pending.add(settled)
    tail = settled
    return work
  }

  async function target(input: { directory: string; worktree?: string; scope: Scope }) {
    if (input.scope === "global") return globalTarget()
    return projectTarget(input)
  }

  async function globalTarget() {
    for (const name of files) {
      const file = path.join(Global.Path.config, name)
      if (await Bun.file(file).exists()) return file
    }
    return path.join(Global.Path.config, "tui.jsonc")
  }

  async function projectTarget(input: { directory: string; worktree?: string }) {
    const found = await Filesystem.findUp([...dirs], input.directory, input.worktree)
    for (const dir of found) {
      for (const name of files) {
        const file = path.join(dir, name)
        if (await Bun.file(file).exists()) return file
      }
    }

    const roots = await Filesystem.findUp([...files], input.directory, input.worktree)
    if (roots[0]) return roots[0]
    return path.join(input.directory, ".kilo", "tui.json")
  }

  async function read(file: string) {
    const target = Bun.file(file)
    if (!(await target.exists())) return undefined
    return target.text()
  }

  function parse(input: string, file: string): Patch {
    const data = ConfigParse.jsonc(input, file)
    if (!isRecord(data)) return {}
    return writable(ConfigParse.schema(TuiConfig.Info, normalize(data), file))
  }

  function normalize(raw: Record<string, unknown>) {
    const data = { ...raw }
    if (!isRecord(data.tui)) {
      delete data.tui
      return data
    }

    const tui = data.tui
    delete data.tui
    return {
      ...tui,
      ...data,
    }
  }

  function merge(base: Patch, patch: Patch): Patch {
    return writable(mergeDeep(base, patch), false)
  }

  function writable(config: Patch | TuiConfig.Info, defaults = true): Editable {
    const result = { ...config } as Record<string, unknown>
    delete result.plugin_origins
    delete result.instruction_origins
    delete result.skill_path_origins
    delete result.permission_origins
    const keybinds: Record<string, string> = defaults
      ? Object.fromEntries(KilocodeKeybinds.list().map((item) => [item.id, item.default]))
      : {}
    for (const [key, value] of Object.entries(config.keybinds ?? {})) {
      if (typeof value === "string") keybinds[key] = value
      if (value === false) keybinds[key] = "none"
    }
    if (defaults || config.keybinds) result.keybinds = keybinds
    else delete result.keybinds

    for (const key of Object.keys(result)) {
      if (result[key] === undefined) delete result[key]
    }

    return result as Editable
  }

  function patchJsonc(input: string, patch: Patch) {
    return Object.entries(patch).reduce((out, [key, value]) => {
      const edits = modify(out, [key], value, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      })
      return applyEdits(out, edits)
    }, input)
  }
}
