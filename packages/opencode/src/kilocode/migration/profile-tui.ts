import { lstat } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { read } from "./profile-file"
import { assertWorking, lookup, type Working } from "./profile-image"

const flag = z.boolean().optional()
const values = z
  .object({
    terminal_title_enabled: flag,
    paste_summary_enabled: flag,
    animations_enabled: flag,
    file_context_enabled: flag,
    session_directory_filter_enabled: flag,
    tips_hidden: flag,
    dismissed_getting_started: flag,
    tool_details_visibility: flag,
    assistant_metadata_visibility: flag,
    scrollbar_visible: flag,
    generic_tool_output_visibility: flag,
    vim_enabled: flag,
    diff_viewer_show_file_tree: flag,
    diff_viewer_single_patch: flag,
    which_key_pending_preview: flag,
    thinking_visibility: flag,
    share_consent: flag,
    diff_wrap_mode: z.enum(["word", "none"]).optional(),
    sidebar: z.enum(["auto", "hide"]).optional(),
    timestamps: z.enum(["hide", "show"]).optional(),
    thinking_mode: z.enum(["show", "hide"]).optional(),
    theme_mode: z.enum(["dark", "light"]).optional(),
    theme_mode_lock: z.enum(["dark", "light"]).optional(),
    diff_viewer_view: z.enum(["split", "unified"]).optional(),
    which_key_layout: z.enum(["dock", "overlay"]).optional(),
    theme: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
      .optional(),
    skipped_version: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/)
      .optional(),
    go_upsell_last_seen_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    go_upsell_dont_show: flag,
    go_upsell_account_rate_limit_last_seen_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    go_upsell_account_rate_limit_dont_show: flag,
  })
  .strict()
const scope = z.object({ state: z.string().min(1).max(4096), values }).strict()
export const tui = z
  .object({
    format: z.literal("raya.tui-preferences"),
    version: z.literal(1),
    reviewOnly: z.literal(true),
    activation: z.literal("held"),
    scopes: z.array(scope).max(128),
    history: z.array(scope).max(256).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const keys = value.scopes.map((scope) => scope.state.toLowerCase())
    if (new Set(keys).size !== keys.length || Buffer.byteLength(JSON.stringify(value)) > 128 * 1024)
      ctx.addIssue({ code: "custom", message: "TUI scope evidence is duplicated or exceeds its bound" })
  })
export type Tui = z.infer<typeof tui>
const key = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file)

/** Display preferences may be restored; execution consent is retained only as inert evidence. */
export function ordinary(input: Tui) {
  const result: Record<string, unknown> = {}
  for (const scope of tui.parse(input).scopes) {
    for (const [name, value] of Object.entries(scope.values)) {
      if (name === "share_consent" || value === undefined) continue
      if (name in result && result[name] !== value) throw new Error("Source TUI display preferences conflict")
      result[name] = value
    }
  }
  return result
}

async function optional(file: string) {
  const info = await lstat(file).catch((err: unknown) => {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined
    throw err
  })
  return info ? (JSON.parse((await read(file, 128 * 1024, 128 * 1024)).value) as unknown) : undefined
}

/** Every live source read resolves through the held physical image, never receiver Global. */
export async function collectTui(working: Working, states: readonly string[]) {
  const captured = assertWorking(working)
  const previous = await optional(path.join(captured.profile.data, "restore-tui.json"))
  const inherited = previous === undefined ? undefined : tui.parse(previous)
  const history = [
    ...new Map(
      [...(inherited?.history ?? []), ...(inherited?.scopes ?? [])].map((scope) => [JSON.stringify(scope), scope]),
    ).values(),
  ]
  const scopes: Tui["scopes"] = []
  for (const state of states) {
    const index = captured.original.findIndex(
      (root) =>
        root.kind === "json" && (key(root.path) === key(state) || key(state).startsWith(key(root.path) + path.sep)),
    )
    if (index < 0) throw new Error("Source state scope is absent from held image")
    const value = await optional(
      path.join(
        lookup(working, captured.original[index].path),
        path.relative(captured.original[index].path, state),
        "kv.json",
      ),
    )
    if (value === undefined) continue
    const selected = { state, values: values.parse(value) }
    scopes.push(selected)
  }
  assertWorking(working)
  const result = tui.parse({
    format: "raya.tui-preferences",
    version: 1,
    reviewOnly: true,
    activation: "held",
    scopes,
    ...(history.length ? { history } : {}),
  })
  ordinary(result)
  return result
}
