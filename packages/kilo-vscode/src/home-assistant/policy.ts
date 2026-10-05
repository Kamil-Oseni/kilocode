import { parse, type Config } from "./config"

export type Goal = Readonly<{ state: "on" | "off"; brightness?: number; rgb_color?: readonly [number, number, number] }>
export function rgb(value: unknown): readonly [number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    ![0, 1, 2].every((index) => Number.isInteger(value[index]) && value[index] >= 0 && value[index] <= 255)
  )
    throw new Error("Invalid light RGB color")
  return Object.freeze([value[0], value[1], value[2]])
}
export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
export function goal(value: unknown): Goal {
  if (
    !record(value) ||
    (value.state !== "on" && value.state !== "off") ||
    Object.keys(value).some((key) => !["state", "brightness", "rgb_color"].includes(key)) ||
    (value.rgb_color !== undefined && value.state !== "on") ||
    (value.brightness !== undefined &&
      (typeof value.brightness !== "number" ||
        !Number.isInteger(value.brightness) ||
        value.brightness < 1 ||
        value.brightness > 255 ||
        value.state !== "on"))
  )
    throw new Error("Invalid light goal")
  return Object.freeze({
    state: value.state,
    ...(value.brightness === undefined ? {} : { brightness: value.brightness as number }),
    ...(value.rgb_color === undefined ? {} : { rgb_color: rgb(value.rgb_color) }),
  })
}
const entities = [
  "light.bedroom_ceiling_light",
  "light.smart_rgbtw_bulb",
  "light.bedroom_left",
  "light.bedroom_right",
  "light.pc_rgb",
]
const scenes = [
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
]
const modes = [
  ...scenes.map((name) => ({ name, entity: "scene." + name, stop: undefined })),
  { name: "wake_mode", entity: "script.wake_mode_sunrise", stop: true },
  { name: "temperature_check", entity: "script.pc_temperature_check", stop: undefined },
]

/** Metadata allowlist only; actual authenticated existence remains mandatory before tools are registered. */
export function selection(input: unknown): Config {
  const config = parse(input)
  if (
    config.entities.some((id) => !entities.includes(id)) ||
    config.modes.some(
      (mode) =>
        !modes.some((item) => item.name === mode.name && item.entity === mode.entity && item.stop === mode.stop),
    )
  )
    throw new Error("Home Assistant selection is outside the reviewed lights and modes")
  return config
}
