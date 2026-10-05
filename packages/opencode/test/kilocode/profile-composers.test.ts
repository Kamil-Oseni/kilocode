import { expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { composers, remapComposers } from "@/kilocode/migration/profile-composers"
import { DraftLegacy } from "@/kilocode/session/composer-codec"
import { withTimeout } from "@/util/timeout"

test("typed composer remapping preserves Unicode and refuses corrupt, duplicate and unmapped entries", () => {
  const content = { text: "literal /source remains café 日本語 😀", comments: [], images: [], scroll: 0 }
  const entry = {
    identity: { key: "pending", box: "sidebar:new-task", workspace: "/source" },
    token: { generation: crypto.randomUUID(), revision: 3 },
    content,
    digest: DraftLegacy.hash(content),
    mutation: "original",
    receipt: { request: "a".repeat(64) },
  }
  const source = composers.parse({ version: 1, entries: [entry] })
  const target = remapComposers(source, new Map([["/source", path.join(os.tmpdir(), "target")]]))
  expect(target.entries[0].content).toEqual(content)
  expect(target.entries[0].token).toEqual(entry.token)
  expect(target.entries[0].receipt).toBeUndefined()
  expect(source.entries[0].receipt).toEqual(entry.receipt)
  expect(() => remapComposers(source, new Map())).toThrow(/Unmapped/)
  expect(() => composers.parse({ version: 1, entries: [entry, entry] })).toThrow()
  expect(() => composers.parse({ version: 1, entries: [{ ...entry, digest: "b".repeat(64) }] })).toThrow()
})

test("encrypted native restore boot, unmounted second import, catalog, edit and reopening use fresh destination owners", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-composer-restores-"))
  const home = path.join(root, "private")
  await mkdir(home)
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) if (/^(?:OTEL_|KILO_|RAYA_)|(?:API_KEY|TOKEN|SECRET)$/.test(key)) delete env[key]
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: path.join(home, "local"),
    KILO_TEST_HOME: home,
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_STATE_HOME: path.join(home, "state"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    RAYA_DB: path.join(home, "unused.db"),
    KILO_DB: path.join(home, "unused.db"),
    RAYA_AUTH_CONTENT: "{}",
    KILO_AUTH_CONTENT: "{}",
    KILO_DISABLE_MODELS_FETCH: "1",
    KILO_DISABLE_AUTOUPDATE: "1",
    KILO_PURE: "1",
  })
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "fixtures/profile-composers-restore.ts"), root],
    { env, stdout: "pipe", stderr: "pipe", windowsHide: true },
  )
  const output = new Response(child.stdout).text()
  const errors = new Response(child.stderr).text()
  try {
    const [code, stdout, stderr] = await withTimeout(
      Promise.all([child.exited, output, errors]),
      60_000,
      `Composer restore diagnostics retained at ${root}`,
    )
    await writeFile(path.join(root, "stdout.log"), stdout)
    await writeFile(path.join(root, "stderr.log"), stderr)
    expect(code, stderr).toBe(0)
    expect(stdout).toContain("COMPOSER_RESTORE_PASS")
    expect(() => process.kill(child.pid, 0)).toThrow()
  } finally {
    if (child.exitCode === null) child.kill()
    await child.exited
  }
}, 70_000)
