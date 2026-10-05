import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { selfHeal } from "../../src/kilocode/migration/profile-self-heal"

test("inactive self-heal codec refuses unknown stages, forged bytes and fabricated ownership", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-self-heal-codec-")))
  const text = JSON.stringify({ outcome: {}, owner: "must-not-be-active" })
  const record = {
    root,
    path: `repair/${"a".repeat(64)}/0.json`,
    text,
    source: "a".repeat(64),
    digest: createHash("sha256").update(text).digest("hex"),
    excluded: ["repair-owner"],
  }
  expect(() => selfHeal.parse({ version: 1, records: [record], files: [], history: [] })).toThrow()
  expect(() =>
    selfHeal.parse({ version: 1, records: [{ ...record, path: "unknown/entry.json" }], files: [], history: [] }),
  ).toThrow()
  const bytes = Buffer.from("forged blob")
  expect(() =>
    selfHeal.parse({
      version: 1,
      records: [],
      history: [],
      files: [
        {
          original: path.join(root, "blobs", "b".repeat(64)),
          kind: "snapshot-blob",
          bytes: bytes.length,
          digest: "b".repeat(64),
          data: bytes.toString("base64"),
        },
      ],
    }),
  ).toThrow()
})

test("actual self-heal writers survive held image and two encrypted inactive imports without replay", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-profile-self-heal-")))
  const inherited = { ...process.env }
  for (const key of Object.keys(inherited))
    if (/^(RAYA|KILO|OPENCODE|OTEL|GIT)_|(?:TOKEN|SECRET|API_KEY)$/.test(key)) delete inherited[key]
  for (const mode of ["setup", "writers", "capture"]) {
    const home = path.join(root, mode === "capture" ? "reader" : "producer")
    await mkdir(home, { recursive: true })
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        "--conditions=browser",
        path.join(import.meta.dir, "fixtures/profile-self-heal.ts"),
        root,
        mode,
      ],
      {
        cwd: home,
        env: {
          ...inherited,
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
          RAYA_DISABLE_MODELS_FETCH: "1",
          KILO_DISABLE_MODELS_FETCH: "1",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    )
    const streams = [new Response(child.stdout).text(), new Response(child.stderr).text()]
    const timer = setTimeout(() => child.kill(), 60_000)
    const [code, out, err] = await Promise.all([child.exited, ...streams])
    clearTimeout(timer)
    await writeFile(path.join(root, mode + "-stdout.log"), out)
    await writeFile(path.join(root, mode + "-stderr.log"), err)
    await writeFile(path.join(root, mode + "-process.json"), JSON.stringify({ pid: child.pid, code }))
    expect({ root, mode, code, err: err.slice(-1800) }).toMatchObject({ code: 0 })
    assert.throws(() => process.kill(child.pid, 0))
    expect(out).toContain("PROFILE_")
  }
}, 180_000)
