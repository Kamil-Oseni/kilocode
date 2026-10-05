import * as vscode from "vscode"
import { Settings } from "./settings"
import { parse, type Config } from "./config"

const modes = [
  "movie_mode",
  "cinematic_mode",
  "sunset_mode",
  "sexy_time_mode",
  "sleep_mode",
  "full_brightness_warm_white",
  "full_brightness_normal_white",
  "evening_wind_down",
  "reading_mode",
  "night_light",
  "focus_mode",
  "gaming_mode",
  "relax_mode",
  "cleaning_mode",
].map((name) => ({
  name,
  entity: "scene." + name,
}))
const scripts = [
  { name: "wake_mode", entity: "script.wake_mode_sunrise", stop: true },
  { name: "temperature_check", entity: "script.pc_temperature_check" },
]

/** Native masked input only. This command never calls HA or forwards the credential to the CLI/webview. */
export function register(context: vscode.ExtensionContext, apply?: (config: Config, token: string) => Promise<void>) {
  const settings = new Settings(context.globalState, context.secrets)
  const jobs = new Set<Promise<void>>()
  const failures = new Set<unknown>()
  const state = { closed: false, active: false }
  const command = vscode.commands.registerCommand("kilo-code.new.setupHomeAssistant", () => {
    if (state.closed || state.active) return
    state.active = true
    const job = setup(settings, state, apply)
      .catch(async (error: unknown) => {
        failures.add(error)
        await vscode.window.showErrorMessage(
          "Home Assistant setup could not finish. The credential was not shown or logged. Check the allowed origin and entities before reconnecting.",
        )
      })
      .finally(() => {
        state.active = false
        jobs.delete(job)
      })
    jobs.add(job)
    return job
  })
  const dispose = async () => {
    state.closed = true
    command.dispose()
    const results = await Promise.allSettled([...jobs])
    const errors = [
      ...new Set([...failures, ...results.flatMap((value) => (value.status === "rejected" ? [value.reason] : []))]),
    ]
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, "Home Assistant setup original failures retained")
  }
  context.subscriptions.push({
    dispose() {
      void dispose().catch(() => console.warn("[Raya] Home Assistant setup cleanup remains uncertain"))
    },
  })
  return { dispose }
}

async function setup(
  settings: Settings,
  state: { closed: boolean },
  apply?: (config: Config, token: string) => Promise<void>,
) {
  const origin = await vscode.window.showInputBox({
    title: "Raya: Connect Home Assistant",
    prompt: "Private numeric IPv4 origin (no credential)",
    value: "http://192.168.100.160",
    ignoreFocusOut: true,
  })
  if (origin === undefined || state.closed) return
  const entities = await vscode.window.showInputBox({
    prompt: "Allowed light entity IDs, separated by commas. Only these lights can be controlled.",
    value: "light.bedroom_ceiling_light, light.smart_rgbtw_bulb, light.bedroom_left, light.bedroom_right, light.pc_rgb",
    ignoreFocusOut: true,
  })
  if (entities === undefined || state.closed) return
  const selected = await vscode.window.showQuickPick(
    [...modes, ...scripts].map((mode) => ({ label: mode.name.replaceAll("_", " "), description: mode.entity, mode })),
    { title: "Allowed existing light modes (existence checked before use)", canPickMany: true, ignoreFocusOut: true },
  )
  if (selected === undefined || state.closed) return
  const config = parse({
    version: 1,
    origin,
    entities: entities.split(",").map((value) => value.trim()),
    modes: selected.map((value) => value.mode),
  })
  const token = await vscode.window.showInputBox({
    title: "Home Assistant credential",
    prompt:
      "Paste the dedicated Raya token. It is stored only in VS Code Secret Storage, never in chat or settings files.",
    password: true,
    ignoreFocusOut: true,
  })
  if (token === undefined || state.closed) return
  await (apply ? apply(config, token) : settings.save(config, token))
  if (state.closed) return
  await vscode.window.showInformationMessage(
    apply
      ? "Home Assistant connected for allowed light tools. Voice requests use the same agent permissions as typed requests."
      : "Home Assistant credential saved securely. Agent light tools are not active until the adapter is installed.",
  )
}
