import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Database } from "bun:sqlite"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { select } from "../../src/kilocode/migration/profile-selection"
import { withWorking, type Working } from "../../src/kilocode/migration/profile-image"
import {
  configScaffold,
  operationalPolicies,
  operationalEntry,
} from "../../src/kilocode/migration/profile-operational-schema"
import {
  readOperational,
  operationalValues,
  bindOperational,
  operationalGroups,
  validateOperational,
  type OperationalClaim,
} from "../../src/kilocode/migration/profile-operational-correspondence"

test("utility cache omission requires the exact pinned release bytes and physical selector", () => {
  const root = path.resolve("operational-cache")
  for (const role of ["ripgrep-cache", "ripgrep-executable"] as const) {
    const policy = operationalPolicies[role]
    const entry = {
      namespace: "primary",
      data: root,
      root,
      role,
      source: path.join(root, policy.file),
      dev: "1",
      ino: "2",
      bytes: policy.bytes,
      digest: policy.digest,
      omission: policy.omission,
      rawBytesPreserved: false,
      activation: "inert",
    }
    expect(operationalEntry.safeParse(entry).success).toBe(true)
    for (const value of [
      { ...entry, digest: "0".repeat(64) },
      { ...entry, bytes: policy.bytes - 1 },
      { ...entry, source: path.join(root, "custom.zip") },
      { ...entry, rawBytesPreserved: true },
    ])
      expect(operationalEntry.safeParse(value).success).toBe(false)
  }
})

test.skipIf(process.platform !== "win32")(
  "native image omissions bind finite bytes without transferring diagnostic content",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-operational-policy-")))
    const data = path.join(root, "data")
    const config = path.join(root, "config")
    const log = path.join(root, "log")
    const bin = path.join(root, "cache", "bin")
    const storage = path.join(data, "storage")
    for (const dir of [data, config, log, bin, storage]) await mkdir(dir, { recursive: true })
    // Explicit byte fixtures exercise the held reader; they do not attest that a source writer ran.
    await writeFile(path.join(config, ".gitignore"), configScaffold)
    const secret = "PRIVATE_DIAGNOSTIC_CONTENT_MUST_NOT_TRANSFER"
    const home = path.join(root, "home")
    await mkdir(home)
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(RAYA|KILO|OPENCODE|OTEL|GIT)_|TOKEN|SECRET|API_KEY|PASSWORD/i.test(key),
      ),
    )
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        "--conditions=browser",
        path.join(import.meta.dir, "fixtures/profile-operational-writers.ts"),
        root,
      ],
      {
        env: {
          ...env,
          HOME: home,
          USERPROFILE: home,
          KILO_TEST_HOME: home,
          XDG_DATA_HOME: path.join(home, "data"),
          XDG_CONFIG_HOME: path.join(home, "config"),
          XDG_STATE_HOME: path.join(home, "state"),
          XDG_CACHE_HOME: path.join(home, "cache"),
          LOCALAPPDATA: path.join(root, "local"),
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
    const deadline = { forced: false }
    const timer = setTimeout(() => {
      deadline.forced = true
      child.kill()
    }, 30000)
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(timer))
    await writeFile(path.join(root, "writer-stdout.log"), out)
    await writeFile(path.join(root, "writer-stderr.log"), err)
    expect(deadline.forced).toBe(false)
    expect(code, err).toBe(0)
    const uuid = await readFile(path.join(data, "telemetry-id"), "utf8")
    expect(await readFile(path.join(storage, "migration"), "utf8")).toBe("2")
    await writeFile(path.join(data, "dev.log"), secret)
    await writeFile(path.join(bin, operationalPolicies["ripgrep-cache"].file), "custom archive")
    await writeFile(path.join(bin, operationalPolicies["ripgrep-executable"].file), "custom executable")
    const database = path.join(data, "raya.db")
    const db = new Database(database)
    db.exec("CREATE TABLE evidence(value TEXT)")
    db.close()
    const helper = path.join(root, "raya-process-host.exe")
    await copyFile(path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe"), helper)
    const digest = createHash("sha256")
      .update(await readFile(helper))
      .digest("hex")
    const policy = { version: 1 as const, directories: [data, config, log, path.dirname(bin)].sort(), files: [] }
    const selected = await select({ database, storage }, policy)
    const selection = {
      ...selected,
      roots: [
        ...selected.roots,
        ...[config, log, bin, path.dirname(bin)].map((dir) => ({ kind: "json" as const, path: dir })),
      ],
      globals: [
        {
          data,
          config,
          log,
          bin,
          cache: path.dirname(bin),
          state: data,
          stateParent: data,
          repos: data,
          homeKilocode: data,
          homeConfigKilo: data,
        },
      ],
    }
    const saved: { token?: Working; claim?: OperationalClaim } = {}
    const capture = (body: (token: Working) => Promise<void>) =>
      withImage(
        {
          roots: selection.roots,
          policy,
          helper: { executable: helper, digest },
          inventory: "directories",
          registry: path.join(root, "registry"),
        },
        (image) => withWorking(image, selection, body),
      )
    await capture(async (token) => {
      const reader = await readOperational(token)
      const value = operationalValues(token, reader)
      assert(value)
      expect(value.entries).toHaveLength(5)
      expect(value.entries.some((entry) => entry.role === "ripgrep-cache")).toBe(false)
      expect(value.entries.some((entry) => entry.source === path.join(data, "dev.log"))).toBe(false)
      expect(JSON.stringify(value)).not.toContain(secret)
      expect(JSON.stringify(value)).not.toContain(uuid)
      const claim = bindOperational(token, reader, { operational: value })
      const groups = operationalGroups(token, claim)
      saved.token = token
      saved.claim = claim
      for (const entry of groups) validateOperational(entry, { operational: value })
      expect(groups.every((entry) => !entry.rawBytesPreserved && entry.activation === "inert")).toBe(true)
      assert.throws(() => operationalGroups(token, { ...claim }), /claim/)
      assert.throws(() => operationalValues(token, { ...reader }), /reader/)
      assert.throws(() => validateOperational({ ...groups[0], digest: "0".repeat(64) }, { operational: value }))
      assert.throws(
        () => bindOperational(token, reader, { operational: { ...value, entries: [] } }),
        /actual held reader/,
      )
      await assert.rejects(writeFile(path.join(log, "dev.log"), "replace"))
    })
    assert(saved.token && saved.claim)
    assert.throws(() => operationalGroups(saved.token!, saved.claim!), /expired|closed|unavailable/)
    await writeFile(path.join(config, ".gitignore"), configScaffold + "\ncustom")
    await writeFile(path.join(storage, "migration"), "1")
    await writeFile(path.join(data, "telemetry-id"), "x".repeat(36))
    await capture(async (token) => {
      const reader = await readOperational(token)
      expect(
        operationalValues(token, reader)
          ?.entries.map((entry) => entry.role)
          .sort(),
      ).toEqual(["effect-diagnostics", "legacy-diagnostics"])
      assert.throws(() => operationalGroups(token, saved.claim!), /another image/)
    })
  },
  60000,
)
