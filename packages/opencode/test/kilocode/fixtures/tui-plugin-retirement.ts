import { strict as assert } from "node:assert"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TuiPluginRuntime } from "../../../src/plugin/tui/runtime"
import { internalTuiPlugins } from "../../../src/plugin/tui/internal"

const root = process.env.RAYA_PLUGIN_PROFILE!
const mode = process.env.RAYA_PLUGIN_CASE!
process.chdir(root)
const entered = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
const server = Bun.serve({
  port: 0,
  async fetch() {
    entered.resolve()
    await release.promise
    return new Response("released")
  },
})
const file = path.join(root, "owned-plugin.ts")
await Bun.write(
  file,
  `import fs from "node:fs/promises"
export const raw = new Error("actual-plugin-cleanup-failed")
export const initial = new Error("actual-plugin-initializer-failed")
export let handle
export let signal
export default {
  id: "raya.actual-retirement",
  async tui(api, opts) {
    handle = await fs.open(opts.file, "w")
    signal = api.lifecycle.signal
    api.lifecycle.onDispose(async () => {
      await handle.writeFile("native-last-marker")
      await handle.close()
      await Bun.write(opts.closed, "closed")
    })
    api.lifecycle.onDispose(async () => {
      if (opts.fail) throw raw
      await Bun.write(opts.other, "other-cleanup-ran")
    })
    if (opts.init) await fetch(opts.url)
    api.lifecycle.onDispose(async () => {
      if (opts.held) await fetch(opts.url)
      await Bun.write(opts.last, "joined-cleanup")
    })
    await Bun.write(opts.ready, "registered")
    if (opts.initial) throw initial
  },
}
`,
)
const spec = pathToFileURL(file).href
const mod = await import(spec)
const opts = {
  file: path.join(root, "native.log"),
  closed: path.join(root, "closed"),
  other: path.join(root, "other"),
  last: path.join(root, "last"),
  ready: path.join(root, "ready"),
  url: server.url.href,
  fail: mode === "failure" || mode === "deactivation",
  held: mode === "held",
  init: mode === "init",
  initial: mode === "initial-failure",
}
const good = path.join(root, "second-plugin.ts")
await Bun.write(
  good,
  `export default { id: "raya.second-plugin", async tui(api, opts) {
  await Bun.write(opts.ready, "second-plugin-initialized")
  api.lifecycle.onDispose(() => Bun.write(opts.closed, "second-plugin-closed"))
} }`,
)
const second = pathToFileURL(good).href
const extra =
  mode === "initial-failure"
    ? [
        [second, { ready: path.join(root, "second-ready"), closed: path.join(root, "second-closed") }] as [
          string,
          Record<string, unknown>,
        ],
      ]
    : []
const config = createTuiResolvedConfig({
  plugin: [[spec, opts], ...extra],
  plugin_origins: [[spec, opts] as [string, Record<string, unknown>], ...extra].map((spec) => ({
    spec,
    scope: "local",
    source: path.join(root, "tui.json"),
  })),
  plugin_enabled: Object.fromEntries(
    internalTuiPlugins({ experimentalEventSystem: false, experimentalSessionSwitcher: false }).map((plugin) => [
      plugin.id,
      false,
    ]),
  ),
})
const failures = (err: unknown): unknown[] =>
  err instanceof AggregateError ? [err, ...err.errors.flatMap(failures)] : [err]
try {
  const startup = TuiPluginRuntime.init({
    api: createTuiPluginApi(),
    config,
    disposeTimeoutMs: mode === "held" ? 20 : 5000,
  })
  if (mode === "init") await entered.promise
  else await startup
  assert.ok(TuiPluginRuntime.list().some((plugin) => plugin.id === "raya.actual-retirement"))
  if (mode === "deactivation") {
    const err = await TuiPluginRuntime.deactivatePlugin("raya.actual-retirement").catch((err: unknown) => err)
    assert.ok(failures(err).includes(mod.raw))
    assert.equal(await Bun.file(opts.closed).text(), "closed")
  }
  const first = TuiPluginRuntime.dispose()
  assert.equal(TuiPluginRuntime.dispose(), first)
  if (mode === "held" || mode === "init") {
    await entered.promise
    let settled = false
    void first.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await Bun.sleep(mode === "held" ? 60 : 20)
    assert.equal(settled, false)
    assert.equal(await Bun.file(opts.closed).exists(), false)
    await assert.rejects(TuiPluginRuntime.activatePlugin("raya.actual-retirement"), /admission is closed/)
    await assert.rejects(TuiPluginRuntime.init({ api: createTuiPluginApi(), config }), /admission is closed/)
    release.resolve()
    await startup
  }
  const err = await first.catch((err: unknown) => err)
  assert.equal(await Bun.file(opts.closed).text(), "closed")
  assert.equal(await Bun.file(opts.file).text(), "native-last-marker")
  assert.equal(mod.signal.aborted, true)
  await assert.rejects(
    mod.handle.write("after-close"),
    (err: unknown) => err instanceof Error && "code" in err && err.code === "EBADF",
  )
  if (mode === "failure" || mode === "deactivation" || mode === "initial-failure") {
    assert.ok(err instanceof AggregateError)
    assert.ok(failures(err).includes(mode === "initial-failure" ? mod.initial : mod.raw))
    if (mode === "initial-failure") {
      assert.equal(await Bun.file(path.join(root, "second-ready")).text(), "second-plugin-initialized")
      assert.equal(await Bun.file(path.join(root, "second-closed")).text(), "second-plugin-closed")
    }
    await assert.rejects(TuiPluginRuntime.init({ api: createTuiPluginApi(), config }), /admission is closed/)
  } else if (mode === "held") {
    assert.ok(err instanceof AggregateError)
    assert.ok(
      failures(err).some((item) => item instanceof Error && item.message.includes("completion remains unconfirmed")),
    )
    assert.equal(await Bun.file(opts.other).text(), "other-cleanup-ran")
    assert.equal(await Bun.file(opts.last).text(), "joined-cleanup")
  } else {
    assert.equal(err, undefined)
    assert.equal(await Bun.file(opts.other).text(), "other-cleanup-ran")
  }
  assert.equal(TuiPluginRuntime.dispose(), first)
  assert.equal(await first.catch((err: unknown) => err), err)
  console.log(JSON.stringify({ mode, passed: true }))
} finally {
  release.resolve()
  await server.stop(true)
}
