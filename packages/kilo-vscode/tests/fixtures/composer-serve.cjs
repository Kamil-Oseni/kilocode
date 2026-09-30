const esbuild = require("esbuild")
const path = require("node:path")
const fs = require("node:fs")
const os = require("node:os")
const babel = require("@babel/core")
const dir = path.resolve(__dirname, "../../node_modules/.cache/composer-browser")
fs.mkdirSync(dir, { recursive: true })
for (const theme of ["light", "dark"])
  fs.copyFileSync(
    path.resolve(__dirname, `../../assets/icons/eden-logo-${theme}.svg`),
    path.join(dir, `eden-logo-${theme}.svg`),
  )
fs.writeFileSync(
  path.join(dir, "index.html"),
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Actual Raya composer</title><link rel="stylesheet" href="/composer-entry.css"></head><body><div id="root"></div><script src="/composer-entry.js"></script></body></html>',
)
const solid = path.dirname(require.resolve("solid-js/package.json"))
const aliases = {
  "solid-js": path.join(solid, "dist/solid.js"),
  "solid-js/web": path.join(solid, "web/dist/web.js"),
  "solid-js/store": path.join(solid, "store/dist/store.js"),
}
const resources = { home: undefined, host: undefined, context: undefined, profiles: new Map(), pending: new Set() }
let closing
function close() {
  if (closing) return closing
  closing = (async () => {
    const errors = []
    const attempt = async (action) => {
      try {
        await action()
      } catch (error) {
        errors.push(error)
      }
    }
    if (resources.context) await attempt(() => resources.context.dispose())
    if (resources.host) await attempt(() => resources.host.stop(true))
    await Promise.allSettled([...resources.pending])
    for (const profile of resources.profiles.values()) await attempt(async () => (await profile)[Symbol.asyncDispose]())
    if (resources.host)
      await attempt(async () => {
        const { AppRuntime } = await import("../../../opencode/src/effect/app-runtime.ts")
        await AppRuntime.dispose()
      })
    if (resources.home) await attempt(() => fs.rmSync(resources.home, { recursive: true, force: true }))
    if (errors.length) throw new AggregateError(errors, "Composer fixture cleanup failed")
    console.log(
      "COMPOSER_FIXTURE_CLEANUP",
      JSON.stringify({
        profileRemoved: !resources.home || !fs.existsSync(resources.home),
        profiles: resources.profiles.size,
      }),
    )
  })()
  return closing
}
async function stop(code) {
  try {
    await close()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
    process.exit(1)
  }
  process.exit(code)
}
process.once("SIGTERM", () => void stop(0))
process.once("SIGINT", () => void stop(0))
async function main() {
  // Set isolation before any runtime module imports (xdg-basedir caches paths).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "raya-composer-relay-"))
  resources.home = home
  const token = process.env.RAYA_COMPOSER_SHUTDOWN
  for (const key of Object.keys(process.env))
    if (/^(RAYA|KILO|OPENCODE|OPENAI|ANTHROPIC|GOOGLE|AZURE|AWS|OPENROUTER|DEEPSEEK|GROQ|MISTRAL|XAI|OTEL)_/.test(key))
      delete process.env[key]
  if (token) process.env.RAYA_COMPOSER_SHUTDOWN = token
  for (const key of ["HOME", "USERPROFILE", "KILO_TEST_HOME", "RAYA_TEST_HOME"]) process.env[key] = home
  for (const key of ["TEMP", "TMP", "APPDATA", "LOCALAPPDATA"]) {
    const dir = path.join(home, key.toLowerCase())
    fs.mkdirSync(dir, { recursive: true })
    process.env[key] = dir
  }
  for (const [key, name] of [
    ["XDG_DATA_HOME", "data"],
    ["XDG_CONFIG_HOME", "config"],
    ["XDG_STATE_HOME", "state"],
    ["XDG_CACHE_HOME", "cache"],
    ["KILO_TEST_MANAGED_CONFIG_DIR", "managed"],
  ])
    process.env[key] = path.join(home, name)
  process.env.KILO_DB = ":memory:"
  process.env.RAYA_DB = ":memory:"
  process.env.KILO_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
  process.env.KILO_MODELS_PATH = path.resolve(__dirname, "../../../opencode/test/tool/fixtures/models-api.json")
  const { draftStorage } = await import("../../../opencode/test/kilocode/composer-draft-fixture.ts")
  const profiles = resources.profiles
  const pending = resources.pending
  const headers = {
    "Access-Control-Allow-Origin": "http://127.0.0.1:5201",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  }
  const host = Bun.serve({
    hostname: "127.0.0.1",
    port: 5202,
    async fetch(request) {
      if (new URL(request.url).pathname === "/__shutdown") {
        if (
          !process.env.RAYA_COMPOSER_SHUTDOWN ||
          request.headers.get("x-fixture-token") !== process.env.RAYA_COMPOSER_SHUTDOWN
        )
          return new Response(null, { status: 403 })
        setTimeout(() => void stop(0), 0)
        return new Response("closing")
      }
      if (closing) return new Response(null, { status: 503, headers })
      if (request.method === "OPTIONS") return new Response(null, { headers })
      if (request.method !== "POST") return new Response(null, { status: 405, headers })
      const job = (async () => {
        const body = await request.json()
        if (typeof body.profile !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(body.profile))
          return new Response(null, { status: 400, headers })
        if (!profiles.has(body.profile)) {
          if (profiles.size >= 64) return new Response(null, { status: 429, headers })
          profiles.set(body.profile, draftStorage())
        }
        const storage = await profiles.get(body.profile)
        return Response.json(await storage.handle(body.message), { headers })
      })().finally(() => pending.delete(job))
      pending.add(job)
      return job
    },
  })
  resources.host = host
  const context = await esbuild.context({
    absWorkingDir: path.resolve(__dirname, "../.."),
    tsconfig: path.resolve(__dirname, "../../webview-ui/tsconfig.json"),
    entryPoints: [path.join(__dirname, "composer-entry.jsx")],
    outdir: dir,
    bundle: true,
    platform: "browser",
    format: "iife",
    conditions: ["browser"],
    loader: { ".woff": "file", ".woff2": "file", ".ttf": "file", ".svg": "file" },
    plugins: [
      {
        name: "composer-production",
        setup(build) {
          build.onResolve({ filter: /^solid-js(\/web|\/store)?$/ }, (args) => ({ path: aliases[args.path] }))
          build.onResolve({ filter: /\?worker&url$/ }, () => ({ path: "worker", namespace: "fixture" }))
          build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: "export default 'unused-worker.js'",
            loader: "js",
          }))
          build.onResolve({ filter: /^@/, namespace: "file" }, (args) =>
            args.kind === "import-rule"
              ? build.resolve(args.path, { kind: "import-statement", resolveDir: args.resolveDir })
              : undefined,
          )
          build.onLoad({ filter: /\.[jt]sx$/ }, async (args) => {
            const result = await babel.transformAsync(fs.readFileSync(args.path, "utf8"), {
              filename: args.path,
              configFile: false,
              babelrc: false,
              presets: [
                [require("babel-preset-solid"), {}],
                [require("@babel/preset-typescript"), {}],
              ],
            })
            if (!result?.code) throw new Error("Composer fixture compilation failed")
            return { contents: result.code, loader: "js" }
          })
        },
      },
    ],
  })
  resources.context = context
  await context.rebuild()
  await context.serve({ host: "127.0.0.1", port: 5201, servedir: dir })
}
main().catch(async (error) => {
  console.error(error)
  await stop(1)
})
