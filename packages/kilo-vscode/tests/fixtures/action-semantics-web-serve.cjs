const esbuild = require("esbuild")
const path = require("node:path")
const fs = require("node:fs")
const babel = require("@babel/core")
const dir = path.resolve(__dirname, "../../node_modules/.cache/action-semantics-web-browser")
const root = path.resolve(__dirname, "../../..")
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(
  path.join(dir, "index.html"),
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Raya web action semantics</title><link rel="stylesheet" href="/action-semantics-web-entry.css"></head><body><div id="root"></div><script src="/action-semantics-web-entry.js"></script></body></html>',
)
const solid = path.dirname(require.resolve("solid-js/package.json"))
const aliases = {
  "solid-js": path.join(solid, "dist/solid.js"),
  "solid-js/web": path.join(solid, "web/dist/web.js"),
}
async function main() {
  const context = await esbuild.context({
    entryPoints: [path.join(__dirname, "action-semantics-web-entry.jsx")],
    outdir: dir,
    bundle: true,
    platform: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "action-semantics-web-production",
        setup(build) {
          build.onResolve({ filter: /^solid-js(\/web)?$/ }, (args) => ({ path: aliases[args.path] }))
          build.onResolve({ filter: /^@kilocode\/kilo-web-ui\/button$/ }, () => ({
            path: path.join(root, "kilo-web-ui/src/components/button.tsx"),
          }))
          build.onResolve({ filter: /^@kilocode\/kilo-web-ui\/styles\/button$/ }, () => ({
            path: path.join(root, "kilo-web-ui/src/styles/button.css"),
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
            if (!result?.code) throw new Error("Web action semantics fixture compilation failed")
            return { contents: result.code, loader: "js" }
          })
        },
      },
    ],
  })
  await context.rebuild()
  await context.serve({ host: "127.0.0.1", port: 5218, servedir: dir })
}
main().catch((error) => {
  console.error(error)
  process.exit(1)
})
