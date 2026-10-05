import { test, expect } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

test("distinct actual Core graphs preserve staged WAL rows independently through encrypted inactive two-hop restore", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-profile-stores-"))
  const child = Bun.spawn(
    [process.execPath, "--conditions=browser", path.join(import.meta.dir, "fixtures/profile-stores.ts"), root],
    {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        KILO_TEST_HOME: root,
        LOCALAPPDATA: path.join(root, "local"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_STATE_HOME: path.join(root, "state"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        RAYA_DB: path.join(root, "unused.db"),
        KILO_DB: path.join(root, "unused.db"),
        RAYA_AUTH_CONTENT: "{}",
        KILO_AUTH_CONTENT: "{}",
        RAYA_DISABLE_MODELS_FETCH: "1",
        KILO_DISABLE_MODELS_FETCH: "1",
      },
    },
  )
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  await Bun.write(path.join(root, "stdout.log"), out)
  await Bun.write(path.join(root, "stderr.log"), err)
  expect(code, `Retained${root}:${err}`).toBe(0)
  expect(await Bun.file(path.join(root, "receipt.json")).json()).toMatchObject({
    passed: true,
    graphs: 2,
    walCopies: 2,
    absenceObserved: true,
    distinctWorkspaceRefs: 2,
    primarySeparate: true,
    inactive: true,
    twoHop: true,
    unknownSchemaRefused: true,
    triggerRefused: true,
    indexRefused: true,
    portableCaptureAuthorized: false,
  })
}, 60000)
