const esbuild = require("esbuild")
const path = require("node:path")
const fs = require("node:fs")
const babel = require("@babel/core")
const dir = path.resolve(__dirname, "../../node_modules/.cache/speech-settings-browser")
fs.mkdirSync(dir, { recursive: true })
for (const theme of ["light", "dark"])
  fs.copyFileSync(
    path.resolve(__dirname, `../../assets/icons/eden-logo-${theme}.svg`),
    path.join(dir, `eden-logo-${theme}.svg`),
  )
fs.writeFileSync(
  path.join(dir, "index.html"),
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Actual Raya Speech settings</title><link rel="stylesheet" href="/speech-settings-entry.css"></head><body><div id="root"></div><script src="/speech-settings-entry.js"></script></body></html>',
)
const solid = path.dirname(require.resolve("solid-js/package.json"))
const aliases = {
  "solid-js": path.join(solid, "dist/solid.js"),
  "solid-js/web": path.join(solid, "web/dist/web.js"),
  "solid-js/store": path.join(solid, "store/dist/store.js"),
}
async function main() {
  const context = await esbuild.context({
    entryPoints: [path.join(__dirname, "speech-settings-entry.jsx")],
    outdir: dir,
    bundle: true,
    platform: "browser",
    format: "iife",
    conditions: ["browser"],
    loader: { ".woff": "file", ".woff2": "file", ".ttf": "file", ".svg": "file" },
    plugins: [
      {
        name: "speech-settings-production",
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
            if (!result?.code) throw new Error("Speech settings fixture compilation failed")
            return { contents: result.code, loader: "js" }
          })
        },
      },
    ],
  })
  await context.rebuild()
  await context.serve({ host: "127.0.0.1", port: 5202, servedir: dir })
}
main().catch((error) => {
  console.error(error)
  process.exit(1)
})
