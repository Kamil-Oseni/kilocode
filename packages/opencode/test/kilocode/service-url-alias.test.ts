import { expect, test } from "bun:test"
import path from "node:path"

const keys = [
  "RAYA_API_URL",
  "KILO_API_URL",
  "RAYA_CHAT_URL",
  "KILO_CHAT_URL",
  "RAYA_EVENT_SERVICE_URL",
  "EVENT_SERVICE_URL",
] as const

type Values = Partial<Record<(typeof keys)[number], string>>

async function load(values: Values) {
  const env = { ...process.env }
  for (const key of keys) delete env[key]
  Object.assign(env, values)
  const script = [
    'const constants = await import("../kilo-gateway/src/api/constants.ts")',
    "console.log(JSON.stringify({ api: constants.KILO_API_BASE, chat: constants.KILO_CHAT_URL, events: constants.KILO_EVENT_SERVICE_URL }))",
  ].join(";")
  const child = Bun.spawn({
    cmd: [process.execPath, "--conditions=browser", "-e", script],
    cwd: path.resolve(import.meta.dir, "../.."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(stderr).toBe("")
  expect(code).toBe(0)
  return JSON.parse(stdout) as { api: string; chat: string; events: string }
}

test("gateway service URLs accept Raya names and retain legacy fallbacks", async () => {
  expect(await load({})).toEqual({
    api: "https://api.kilo.ai",
    chat: "https://chat.kiloapps.io",
    events: "wss://events.kiloapps.io",
  })
  expect(
    await load({
      KILO_API_URL: "https://legacy-api.example",
      KILO_CHAT_URL: "https://legacy-chat.example",
      EVENT_SERVICE_URL: "wss://legacy-events.example",
    }),
  ).toEqual({
    api: "https://legacy-api.example",
    chat: "https://legacy-chat.example",
    events: "wss://legacy-events.example",
  })
  expect(
    await load({
      RAYA_API_URL: "https://raya-api.example",
      KILO_API_URL: "https://legacy-api.example",
      RAYA_CHAT_URL: "https://raya-chat.example",
      KILO_CHAT_URL: "https://legacy-chat.example",
      RAYA_EVENT_SERVICE_URL: "wss://raya-events.example",
      EVENT_SERVICE_URL: "wss://legacy-events.example",
    }),
  ).toEqual({
    api: "https://raya-api.example",
    chat: "https://raya-chat.example",
    events: "wss://raya-events.example",
  })
  expect(
    await load({
      RAYA_API_URL: "",
      KILO_API_URL: "https://legacy-api.example",
      RAYA_CHAT_URL: "",
      KILO_CHAT_URL: "https://legacy-chat.example",
      RAYA_EVENT_SERVICE_URL: "",
      EVENT_SERVICE_URL: "wss://legacy-events.example",
    }),
  ).toEqual({ api: "", chat: "", events: "" })
})
