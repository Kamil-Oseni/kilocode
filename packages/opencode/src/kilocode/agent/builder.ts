import path from "path"
import fs from "fs/promises"
import z from "zod"
import { Global } from "@opencode-ai/core/global"
import { ConfigIntent } from "@opencode-ai/core/kilocode/config-intent"
import { publish } from "@opencode-ai/core/kilocode/markdown-publication"
import { acquireProfileRoot, resolveProfileRoot } from "@opencode-ai/core/kilocode/profile-maintenance"
import { registerProcessProfile } from "@opencode-ai/core/kilocode/process-profile"
import { KiloShutdown } from "@/kilocode/cli/shutdown"

export namespace AgentBuilder {
  const pending = new Set<Promise<void>>()
  const failures: unknown[] = []
  let closing: Promise<void> | undefined

  KiloShutdown.register(() => {
    if (closing) return closing
    closing = Promise.all(pending).then(() => {
      if (failures.length) throw new AggregateError(failures, "Agent builder retirement failed")
    })
    return closing
  })
  export const Scope = z.enum(["global", "project"])
  export type Scope = z.infer<typeof Scope>

  export const Mode = z.enum(["primary", "subagent", "all"])

  export const ID = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)

  export const Params = z.object({
    id: ID,
  })

  const Body = z.object({
    scope: Scope.default("project"),
    description: z.string().optional(),
    mode: Mode.default("primary"),
    model: z.string().optional(),
    color: z.string().optional(),
    steps: z.number().int().positive().optional(),
    tools: z.string().array().optional(),
    permission: z.record(z.string(), z.unknown()).optional(),
    prompt: z.string().regex(/\S/).trim(),
  })

  export const Input = Body.extend({
    id: ID,
  })
  export type Input = z.infer<typeof Input>

  export const SaveInput = Body.extend({
    id: ID.optional(),
  })
  export type SaveInput = z.infer<typeof SaveInput>

  export const Output = z.object({
    id: ID,
    scope: Scope,
    path: z.string(),
    markdown: z.string(),
  })
  export type Output = z.infer<typeof Output>

  export type Ctx = {
    directory: string
    worktree?: string
  }

  export async function preview(ctx: Ctx, input: Input): Promise<Output> {
    return {
      id: input.id,
      scope: input.scope,
      path: file(ctx, input.scope, input.id),
      markdown: markdown(input),
    }
  }

  export function save(ctx: Ctx, input: Input): Promise<Output> {
    if (closing) return Promise.reject(new Error("Agent builder is retired"))
    const work = (async () => {
      const output = {
        id: input.id,
        scope: input.scope,
        path: file(ctx, input.scope, input.id),
        markdown: markdown(input),
      }
      const ticket = ConfigIntent.reserveMarkdown(path.resolve(output.path))
      const selected = path.resolve(
        input.scope === "global"
          ? Global.Path.config
          : ctx.worktree && ctx.worktree !== "/"
            ? ctx.worktree
            : ctx.directory,
      )
      const dir = path.dirname(path.resolve(output.path))
      const target = path.resolve(output.path)
      const roots = await Promise.all(
        [selected, dir, target].map((path) => resolveProfileRoot({ kind: "json", path })),
      ).catch((err) => {
        ticket.fail(err)
        throw err
      })
      const expected = path.join(roots[1].path, path.basename(output.path))
      if (
        (process.platform === "win32" ? roots[2].path.toLowerCase() : roots[2].path) !==
        (process.platform === "win32" ? expected.toLowerCase() : expected)
      ) {
        const err = new Error("Agent builder target is outside its admitted directory")
        ticket.fail(err)
        throw err
      }
      const scopes = [...new Map(roots.slice(0, 2).map((root) => [root.id, root])).values()]
      scopes.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      const leases: Awaited<ReturnType<typeof acquireProfileRoot>>[] = []
      const errors: unknown[] = []
      async function check() {
        const current = await Promise.all(
          [selected, dir, target].map((path) => resolveProfileRoot({ kind: "json", path })),
        )
        if (current.some((root, index) => root.id !== roots[index].id))
          throw new Error("Agent builder target changed during save")
      }
      try {
        for (const root of scopes) {
          const lease = await acquireProfileRoot(root)
          leases.push(lease)
          if (lease.id !== root.id) throw new Error("Agent builder scope changed during admission")
        }
        await check()
        registerProcessProfile(scopes.map((root) => root.path))
        const predecessor = await ticket.prepare(roots[2].path)
        await fs.mkdir(roots[1].path, { recursive: true })
        await check()
        const receipt = await publish(roots[2].path, output.markdown, predecessor)
        await ticket.complete(receipt)
        await check()
      } catch (err) {
        ticket.fail(err)
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
      if (errors.length) throw new AggregateError(errors, "Agent builder save failed")
      return output
    })()
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
    return work
  }

  function file(ctx: Ctx, scope: Scope, id: string) {
    const root =
      scope === "global" ? Global.Path.config : ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : ctx.directory
    return path.join(root, scope === "global" ? "agent" : ".kilo/agent", `${id}.md`)
  }

  function markdown(input: Input) {
    const permission = input.tools?.length
      ? {
          ...Object.fromEntries(input.tools.map((tool) => [tool, "allow"])),
          ...input.permission,
        }
      : input.permission
    const data = clean({
      description: input.description,
      mode: input.mode,
      model: input.model,
      color: input.color,
      steps: input.steps,
      permission,
    })
    return `---\n${Object.entries(data)
      .map(([key, value]) => `${key}: ${format(value)}`)
      .join("\n")}\n---\n${input.prompt.trim()}\n`
  }

  function clean(input: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
  }

  function format(input: unknown): string {
    if (typeof input === "string") return JSON.stringify(input)
    if (typeof input === "number" || typeof input === "boolean") return String(input)
    return JSON.stringify(input)
  }
}
