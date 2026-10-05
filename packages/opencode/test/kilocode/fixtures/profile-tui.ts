import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { processProfileSnapshot, sourceScopes } from "@opencode-ai/core/kilocode/process-profile"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { kvOwner } from "../../../../tui/src/kilocode/kv-owner"
import { stateScopes } from "../../../src/kilocode/migration/profile-scope"
import { collectTui, ordinary, tui } from "../../../src/kilocode/migration/profile-tui"
import { withWorking } from "../../../src/kilocode/migration/profile-image"
import { select } from "../../../src/kilocode/migration/profile-selection"
import { unseal, seal } from "../../../src/kilocode/migration/profile-bundle"
import { restore } from "../../../src/kilocode/migration/profile-restore"
import { finish } from "../../../src/kilocode/cli/finish"

const root = process.argv[2]
if (process.argv[3] === "source") {
  const injected = path.join(root, "injected-state")
  await mkdir(injected)
  Global.make({ state: injected })
  const scopes = sourceScopes()
  for (const state of scopes.states) {
    const owner = kvOwner(path.join(state, "kv.json"))
    await Promise.all([
      owner.write({ animations_enabled: false }),
      owner.write({
        animations_enabled: false,
        theme: "kilo",
        which_key_layout: "overlay",
        share_consent: true,
      }),
    ])
    await owner.retire()
    assert.throws(() => owner.write({ animations_enabled: true }), /retired/)
  }
  await writeFile(
    path.join(root, "scopes.json"),
    JSON.stringify({ scopes, roots: processProfileSnapshot().roots.map((path) => ({ kind: "json", path })) }),
  )
  await import("./profile-import-bundle")
} else if (process.argv[3] === "change") {
  const state = path.join(root, "destination", "state", "kilo")
  Global.make({ state })
  const owner = kvOwner(path.join(state, "kv.json"))
  await owner.write({
    animations_enabled: true,
    theme_mode: "light",
    skipped_version: "snapshot-updated-nonce",
    share_consent: true,
  })
  await owner.retire()
  await finish([])
} else {
  const evidence = JSON.parse(await readFile(path.join(root, "scopes.json"), "utf8"))
  const policy = { version: 1 as const, directories: [root], files: [] }
  const scopes = await stateScopes(evidence.scopes, evidence.roots, policy)
  assert.ok(scopes.length >= 2)
  await assert.rejects(stateScopes(evidence.scopes, [], policy), /historical ownership/)
  await assert.rejects(
    stateScopes(evidence.scopes, evidence.roots, { version: 1, directories: [path.join(root, "reader")], files: [] }),
    /policy directory/,
  )
  assert.throws(() =>
    tui.parse({
      format: "raya.tui-preferences",
      version: 1,
      reviewOnly: true,
      activation: "held",
      scopes: [{ state: root, values: { plugin_unknown: "private" } }],
    }),
  )
  const data = path.join(root, "producer")
  const storage = path.join(data, "storage")
  await mkdir(storage)
  const selected = await select({ database: path.join(data, "source.db"), storage, data }, policy)
  const roots = [
    ...selected.roots,
    ...scopes.filter(
      (state) =>
        !selected.roots.some((parent) => parent.kind === "json" && state.path.startsWith(parent.path + path.sep)),
    ),
  ]
  const helper = await realpath(
    path.resolve(import.meta.dir, "../../../../core/native/kilocode/bin/raya-process-host.exe"),
  )
  const digest = createHash("sha256")
    .update(await readFile(helper))
    .digest("hex")
  let captured: ReturnType<typeof tui.parse> | undefined
  let expired: Parameters<typeof collectTui>[0] | undefined
  await withImage(
    { roots, policy, helper: { executable: helper, digest }, registry: path.join(root, "image-registry") },
    (image) =>
      withWorking(image, { ...selected, roots }, async (working) => {
        expired = working
        captured = await collectTui(
          working,
          scopes.map((root) => root.path),
        )
        assert.equal(captured.scopes.length, scopes.length)
        assert.deepEqual(ordinary(captured), { animations_enabled: false, which_key_layout: "overlay", theme: "kilo" })
        await assert.rejects(writeFile(path.join(scopes[0].path, "kv.json"), "{}"))
      }),
  )
  assert.ok(expired)
  await assert.rejects(collectTui(expired, []), /expired/)
  assert.ok(captured)
  const saved = captured
  const original = await unseal(await readFile(path.join(root, "profile.raya"), "utf8"), "é".repeat(6))
  const first = await restore(
    await seal({ ...original, tui: captured }, "é".repeat(6)),
    "é".repeat(6),
    path.join(root, "destination"),
    { [original.workspaces[0]]: original.workspaces[0] },
  )
  const state = path.join(first.env.XDG_STATE_HOME, "kilo", "kv.json")
  const active = JSON.parse(await readFile(state, "utf8"))
  assert.equal(active.share_consent, undefined)
  assert.equal(active.animations_enabled, false)
  assert.deepEqual(JSON.parse(await readFile(path.join(first.path, "restore-tui.json"), "utf8")), captured)
  assert.equal(first.uncertainWork, "held-no-replay")
  const home = path.join(root, "change-home")
  const child = Bun.spawn([process.execPath, "run", "--conditions=browser", import.meta.filename, root, "change"], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      KILO_TEST_HOME: home,
      LOCALAPPDATA: path.join(home, "local"),
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_STATE_HOME: path.join(home, "state"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      RAYA_DB: path.join(home, "unused.db"),
      KILO_DB: path.join(home, "unused.db"),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  await writeFile(path.join(root, "change-stdout.log"), output)
  await writeFile(path.join(root, "change-stderr.log"), error)
  assert.equal(code, 0, error)
  assert.throws(() => process.kill(child.pid, 0))
  const updated = { animations_enabled: true, theme_mode: "light", skipped_version: "snapshot-updated-nonce" }
  const next = await select(
    { database: path.join(first.path, "raya.db"), storage: path.join(first.path, "storage"), data: first.path },
    policy,
  )
  const destination = path.dirname(state)
  let inherited: ReturnType<typeof tui.parse> | undefined
  await withImage(
    {
      roots: [...next.roots, { kind: "json", path: destination }],
      policy,
      helper: { executable: helper, digest },
      registry: path.join(root, "second-image-registry"),
    },
    (image) =>
      withWorking(image, { ...next, roots: [...next.roots, { kind: "json", path: destination }] }, async (working) => {
        inherited = await collectTui(working, [destination])
      }),
  )
  assert.ok(inherited)
  assert.deepEqual(ordinary(inherited), updated)
  assert.equal(inherited.scopes.length, 1)
  assert.ok(inherited.history)
  assert.deepEqual(inherited.history, captured.scopes)
  assert.equal(inherited.history.filter((scope) => scope.values.share_consent === true).length, captured.scopes.length)
  const second = await restore(
    await seal({ ...original, tui: inherited }, "é".repeat(6)),
    "é".repeat(6),
    path.join(root, "second"),
    { [original.workspaces[0]]: original.workspaces[0] },
  )
  assert.deepEqual(JSON.parse(await readFile(path.join(second.env.XDG_STATE_HOME, "kilo", "kv.json"), "utf8")), updated)
  assert.throws(
    () =>
      ordinary(
        tui.parse({
          ...saved,
          scopes: [...saved.scopes, { state: "conflicting", values: { animations_enabled: true } }],
        }),
      ),
    /conflict/,
  )
  console.log("TUI_SCOPE_IMAGE_RESTORE_OK")
  await finish([])
}
