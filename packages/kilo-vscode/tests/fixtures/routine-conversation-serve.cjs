const esbuild = require("esbuild")
const path = require("node:path")
const fs = require("node:fs")
const babel = require("@babel/core")
const dir = path.resolve(__dirname, "../../node_modules/.cache/routine-conversation-browser")
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(
  path.join(dir, "index.html"),
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Actual Raya Routine conversation</title><style>html,body,#root{height:100%;margin:0}</style><link rel="stylesheet" href="/routine-conversation-entry.css"></head><body><div id="root"></div><script src="/routine-conversation-entry.js"></script></body></html>',
)
const solid = path.dirname(require.resolve("solid-js/package.json"))
const aliases = {
  "solid-js": path.join(solid, "dist/solid.js"),
  "solid-js/web": path.join(solid, "web/dist/web.js"),
  "solid-js/store": path.join(solid, "store/dist/store.js"),
}
async function main() {
  const context = await esbuild.context({
    entryPoints: [path.join(__dirname, "routine-conversation-entry.jsx")],
    outdir: dir,
    bundle: true,
    platform: "browser",
    format: "iife",
    conditions: ["browser"],
    loader: { ".woff": "file", ".woff2": "file", ".ttf": "file", ".svg": "file" },
    plugins: [
      {
        name: "run-review-production",
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
            if (!result?.code) throw new Error("Routine conversation fixture compilation failed")
            return { contents: result.code, loader: "js" }
          })
        },
      },
    ],
  })
  await context.rebuild()
  const { loadSessions } = await import("../../src/kilo-provider-utils.ts")
  const profiles = new Map()
  const state = (id) => {
    if (!profiles.has(id))
      profiles.set(id, { opened: [], held: Promise.withResolvers(), release: Promise.withResolvers() })
    return profiles.get(id)
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 5214,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/opened" && request.method === "POST") {
        const value = await request.json()
        state(value.profile).opened = value.opened
        return new Response(null, { status: 204 })
      }
      if (url.pathname === "/held") {
        await state(url.searchParams.get("profile")).held.promise
        return new Response(null, { status: 204 })
      }
      if (url.pathname === "/release" && request.method === "POST") {
        state(url.searchParams.get("profile")).release.resolve()
        return new Response(null, { status: 204 })
      }
      if (url.pathname === "/catalog" && request.method === "POST") {
        const value = await request.json()
        const profile = state(value.profile)
        let result
        await loadSessions({
          pendingSessionRefresh: false,
          connectionState: "connected",
          listSessions: async () => {
            if (value.mode === "held") {
              profile.held.resolve()
              await profile.release.promise
            }
            return []
          },
          sessionDirectories: new Map(),
          workspaceDirectory: value.directory,
          openSessions: () => profile.opened.map((id) => ({ id, directory: value.directory })),
          getSession: async (id) => {
            if (value.mode === "unknown") throw new Error("Session lookup unavailable")
            if (value.mode === "missing") return undefined
            return {
              id: value.mode === "identity" ? "different" : id,
              projectID: "project",
              directory: value.mode === "foreign" ? "C:\\foreign-fixture" : value.directory,
              title: "Original Routine conversation",
              time: {
                created: 1792411200000,
                updated: 1792411201000,
                ...(value.mode === "archived" ? { archived: 0 } : {}),
              },
              metadata: { rayaRoutine: { version: 2, agentID: "worker", runID: "run-original" } },
            }
          },
          postMessage: (message) => {
            result = message
          },
        })
        return result ? Response.json(result) : new Response(null, { status: 204 })
      }
      const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1)
      const file = path.resolve(dir, relative)
      if (!file.startsWith(dir + path.sep)) return new Response("Refused", { status: 403 })
      return new Response(Bun.file(file))
    },
  })
  const close = async () => {
    server.stop(true)
    await context.dispose()
    process.exit(0)
  }
  process.once("SIGTERM", () => void close())
  process.once("SIGINT", () => void close())
}
main().catch((error) => {
  console.error(error)
  process.exit(1)
})
