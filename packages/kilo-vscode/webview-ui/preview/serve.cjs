// raya_change - dev-only preview harness: esbuild serve at http://localhost:5199.
// Builds webview-ui/preview/index.tsx in memory and serves it beside index.html,
// so isolated components can be reviewed without packaging the extension.
const esbuild = require("esbuild")
const path = require("path")
const fs = require("fs")
const crypto = require("crypto")
const core = require("@babel/core")
const solid = require("babel-preset-solid")
const ts = require("@babel/preset-typescript")

const PORT = 5199
const HOST = "127.0.0.1"
const previewDir = __dirname
const cacheDir = path.join(__dirname, "..", "..", "node_modules", ".cache", "raya-preview-solid")
const memory = new Map()
const stamp = crypto
  .createHash("sha256")
  .update(fs.readFileSync(__filename, "utf8"))
  .update(require("babel-preset-solid/package.json").version || "")
  .update(require("@babel/preset-typescript/package.json").version || "")
  .digest("hex")
  .slice(0, 8)

fs.mkdirSync(cacheDir, { recursive: true })

/**
 * Transform Solid JSX with the same Babel preset the extension build uses
 * (esbuild's built-in JSX cannot compile Solid's fine-grained output).
 * Cache hits keep Playwright from waiting on a 503 while Babel walks PromptInput.
 */
const previewSolidPlugin = {
  name: "preview-solid",
  setup(build) {
    build.onLoad({ filter: /\.(t|j)sx$/ }, async (args) => {
      let mtime = 0
      let size = 0
      try {
        const st = fs.statSync(args.path)
        mtime = st.mtimeMs
        size = st.size
      } catch (err) {
        console.warn("[raya preview] could not stat source for cache key", args.path, err)
      }
      const key = `${args.path}:${mtime}:${size}:${stamp}`
      const hit = memory.get(key)
      if (hit) return { contents: hit, loader: "js" }
      const disk = path.join(cacheDir, crypto.createHash("sha256").update(key).digest("hex") + ".js")
      if (fs.existsSync(disk)) {
        try {
          const code = fs.readFileSync(disk, "utf8")
          memory.set(key, code)
          return { contents: code, loader: "js" }
        } catch (err) {
          console.warn("[raya preview] cache read failed, rebuilding", disk, err)
        }
      }
      const source = fs.readFileSync(args.path, "utf8")
      const result = await core.transformAsync(source, {
        presets: [
          [solid, {}],
          [ts, {}],
        ],
        filename: path.basename(args.path),
        sourceMaps: "inline",
      })
      if (result?.code === void 0 || result.code === null) {
        throw new Error("No result was provided from Babel")
      }
      memory.set(key, result.code)
      try {
        fs.writeFileSync(disk, result.code)
      } catch (err) {
        console.warn("[raya preview] cache write failed", disk, err)
      }
      return { contents: result.code, loader: "js" }
    })
  },
}

/**
 * Force every solid-js import to resolve to one shared copy so SolidJS
 * contexts work across kilo-ui and the preview bundle. Mirrors esbuild.js.
 */
const solidDedupePlugin = {
  name: "preview-solid-dedupe",
  setup(build) {
    const solidRoot = path.dirname(require.resolve("solid-js/package.json"))
    const aliases = {
      "solid-js": path.join(solidRoot, "dist", "solid.js"),
      "solid-js/web": path.join(solidRoot, "web", "dist", "web.js"),
      "solid-js/store": path.join(solidRoot, "store", "dist", "store.js"),
    }
    build.onResolve({ filter: /^solid-js(\/web|\/store)?$/ }, (args) => {
      const resolved = aliases[args.path]
      if (resolved) return { path: resolved }
    })
  },
}

/**
 * Resolve `@import` of package paths inside CSS, same as the extension build.
 */
const cssPackageResolvePlugin = {
  name: "preview-css-package-resolve",
  setup(build) {
    build.onResolve({ filter: /^@/, namespace: "file" }, (args) => {
      if (args.kind === "import-rule") {
        return build.resolve(args.path, {
          kind: "import-statement",
          resolveDir: args.resolveDir,
        })
      }
    })
  },
}

/**
 * PromptInput and HistoryView pull markdown/diff workers. The preview never
 * runs those workers, so stub the Vite-style `?worker&url` imports.
 */
const workerStubPlugin = {
  name: "preview-worker-stub",
  setup(build) {
    build.onResolve({ filter: /\?worker&url$/ }, () => ({ path: "worker", namespace: "preview-worker" }))
    build.onLoad({ filter: /.*/, namespace: "preview-worker" }, () => ({
      contents: "export default 'unused-worker.js'",
      loader: "js",
    }))
  },
}

// raya_change - keep every generated bundle below one ignored directory so a
// preview run cannot pollute git status or make ESLint scan vendored output.
function getConfig(check) {
  return {
    entryPoints: [path.join(previewDir, "index.tsx")],
    outdir: check
      ? path.join(__dirname, "..", "..", "node_modules", ".cache", "raya-preview")
      : path.join(previewDir, ".serve"),
    bundle: true,
    format: "iife",
    platform: "browser",
    sourcemap: true,
    sourcesContent: false,
    logLevel: check ? "info" : "silent",
    loader: {
      ".woff": "file",
      ".woff2": "file",
      ".ttf": "file",
      ".svg": "file", // raya_change - provider context can include shared file icons
    },
    plugins: [solidDedupePlugin, cssPackageResolvePlugin, workerStubPlugin, previewSolidPlugin],
  }
}

async function main() {
  if (process.argv.includes("--check")) {
    await esbuild.build(getConfig(true))
    return
  }
  const ctx = await esbuild.context(getConfig(false))
  // Compile before listen so Playwright's URL probe does not sit on esbuild's
  // in-progress 503 for the production PromptInput / HistoryView graph.
  await ctx.rebuild()
  await ctx.watch()
  const server = await ctx.serve({
    servedir: previewDir,
    host: HOST,
    port: PORT,
  })

  console.log(`[raya preview] serving on http://localhost:${server.port}`)
  console.log(`[raya preview] all states: http://localhost:${server.port}/`)
  console.log(`[raya preview] one state:  http://localhost:${server.port}/?state=dark-hover`)

  const shutdown = () => {
    ctx.dispose()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((err) => {
  console.error("[raya preview] failed to start:", err)
  process.exit(1)
})
