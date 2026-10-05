import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { collect } from "../../src/kilocode/migration/profile-artifacts"
import { payload, seal, snapshot, tables, unseal } from "../../src/kilocode/migration/profile-bundle"
import { collectDisposition } from "../../src/kilocode/migration/profile-disposition"
import { assertWorking, lookup, withWorking, type Working } from "../../src/kilocode/migration/profile-image"
import { historicalValues, readHistorical } from "../../src/kilocode/migration/profile-restored-evidence"
import {
  bindRestoredGit,
  restoredGitGroups,
  restoredGitValues,
} from "../../src/kilocode/migration/profile-restored-git-correspondence"
import { select } from "../../src/kilocode/migration/profile-selection"
import { withTimeout } from "../../src/util/timeout"
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
test.skipIf(process.platform !== "win32")(
  "held Git projections remain crosslinked across three actual public inactive imports",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-restored-git-import-")))
    const env = { ...process.env }
    for (const name of Object.keys(env))
      if (/^(?:OTEL_|RAYA_|KILO_|OPENCODE_|GIT_)|(?:API_KEY|TOKEN|SECRET)$/.test(name)) delete env[name]
    const home = (dir: string) => ({
      HOME: dir,
      USERPROFILE: dir,
      KILO_TEST_HOME: dir,
      LOCALAPPDATA: path.join(dir, "local"),
      XDG_DATA_HOME: path.join(dir, "data"),
      XDG_CONFIG_HOME: path.join(dir, "config"),
      XDG_CACHE_HOME: path.join(dir, "cache"),
      XDG_STATE_HOME: path.join(dir, "state"),
      RAYA_DB: path.join(dir, "unused.db"),
      KILO_DB: path.join(dir, "unused.db"),
      RAYA_AUTH_CONTENT: "{}",
      KILO_AUTH_CONTENT: "{}",
      KILO_DISABLE_MODELS_FETCH: "1",
      KILO_DISABLE_AUTOUPDATE: "1",
      KILO_PURE: "1",
    })
    const run = async (name: string, args: string[], stdin = "") => {
      const child = Bun.spawn(args, {
        env: {
          ...env,
          ...home(path.join(root, "runtime", name)),
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: path.join(root, "absent-config"),
          GIT_TERMINAL_PROMPT: "0",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      })
      await child.stdin.write(stdin)
      await child.stdin.end()
      const out = new Response(child.stdout).text(),
        err = new Response(child.stderr).text()
      try {
        const result = await withTimeout(Promise.all([child.exited, out, err]), 45000, "Private Git import deadline")
        await writeFile(path.join(root, name + ".stderr.log"), result[2])
        assert.equal(result[0], 0, result[2])
        expect(result[1] + result[2]).not.toContain("é".repeat(6))
        expect(() => process.kill(child.pid, 0)).toThrow()
        return result[1]
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL")
        await Promise.all([child.exited, out, err])
      }
    }
    await mkdir(path.join(root, "producer"))
    await run("seed", [
      process.execPath,
      "run",
      "--conditions=browser",
      path.join(import.meta.dir, "fixtures/profile-import-bundle.ts"),
      root,
    ])
    const workspace = path.join(root, "source-workspace"),
      data = path.join(root, "source-data")
    await mkdir(path.join(data, "storage"), { recursive: true })
    await copyFile(path.join(root, "producer", "source.db"), path.join(data, "raya.db"))
    for (const args of [
      ["init"],
      ["config", "user.name", "Private Fixture"],
      ["config", "user.email", "fixture@example.invalid"],
    ])
      await run("git-" + args[0] + args[1], ["git", "-C", workspace, ...args])
    await writeFile(path.join(workspace, "actual.txt"), "PUBLIC_GIT_CAFÉ_日本語_😀\n")
    await run("git-add", ["git", "-C", workspace, "add", "."])
    await run("git-commit", ["git", "-C", workspace, "commit", "-m", "private original"])
    await run("git-pack", ["git", "-C", workspace, "repack", "-ad"])
    const helper = path.join(root, "raya-process-host.exe")
    assert.ok(process.env.RAYA_GIT_FIXTURE_HELPER)
    await copyFile(process.env.RAYA_GIT_FIXTURE_HELPER, helper)
    const digest = sha(await readFile(helper))
    const capture = async <T>(dir: string, extras: string[], body: (token: Working) => Promise<T>) => {
      const storage = path.join(dir, "storage"),
        database = path.join(dir, "raya.db")
      const policy = { version: 1 as const, directories: [dir, ...extras].sort(), files: [] }
      const selected = await select({ storage, database }, policy)
      const roots = [...selected.roots, ...extras.map((file) => ({ kind: "json" as const, path: file }))]
      const roles = {
        data: dir,
        config: dir,
        cache: dir,
        state: storage,
        stateParent: dir,
        bin: dir,
        log: dir,
        repos: dir,
        homeKilocode: dir,
        homeConfigKilo: dir,
      }
      return withImage(
        {
          roots,
          policy,
          helper: { executable: helper, digest },
          registry: path.join(root, "registry", crypto.randomUUID()),
        },
        (image) => withWorking(image, { ...selected, roots, globals: [roles] }, body),
      )
    }
    const seed = await unseal(await readFile(path.join(root, "profile.raya"), "utf8"), "é".repeat(6))
    const base = snapshot.parse(Object.fromEntries(Object.entries(seed).filter(([key]) => key !== "archives")))
    let value = await capture(data, [workspace], async (token) =>
      payload.parse({ ...seed, artifacts: await collect(token, { data, workspaces: [workspace] }) }),
    )
    for (const hop of [1, 2, 3]) {
      const archive = path.join(root, "hop" + hop + ".raya"),
        bytes = await seal(value, "é".repeat(6))
      await writeFile(archive, bytes)
      const mapped = path.join(root, "mapped" + hop),
        target = path.join(root, "target" + hop)
      await mkdir(mapped)
      const mapping = path.join(root, "mapping" + hop + ".json")
      await writeFile(
        mapping,
        JSON.stringify({
          workspaces: Object.fromEntries(value.workspaces.map((dir) => [dir, mapped])),
          primaries: value.workspaces,
        }),
      )
      const stdout = await run(
        "import" + hop,
        [
          process.execPath,
          "run",
          "--conditions=browser",
          path.join(import.meta.dir, "../../src/kilocode/cli/entry.ts"),
          "profile-import",
          archive,
          target,
          "--mapping",
          mapping,
          "--sha256",
          sha(bytes),
        ],
        JSON.stringify({ password: "é".repeat(6) }),
      )
      const result = JSON.parse(stdout.trim())
      const dir = path.join(target, "data", "kilo")
      expect(result.path).toBe(dir)
      expect(result.reviewed).toBe(false)
      const db = new Database(path.join(dir, "raya.db"), { readonly: true })
      try {
        expect(db.query("PRAGMA quick_check").values()).toEqual([["ok"]])
        expect(db.query("SELECT count(*) FROM session_input").values()).toEqual([[0]])
        expect(db.query("SELECT data FROM part").values()[0][0]).toContain("IMPORT_CAFÉ_日本語_😀")
      } finally {
        db.close()
      }
      expect(JSON.parse(await readFile(path.join(dir, "storage/raya/agent.json"), "utf8"))[0].enabled).toBe(false)
      expect(JSON.parse(await readFile(path.join(dir, "storage/raya/restore-hold.json"), "utf8")).state).toBe("held")
      await run("git-status" + hop, ["git", "-C", mapped, "status", "--porcelain"])
      const next = await capture(dir, [mapped], async (token) => {
        const reader = await readHistorical(token),
          archives = [...historicalValues(token, reader)]
        const proof = await bindRestoredGit(token, reader, { archives })
        expect(restoredGitGroups(token, proof).some((entry) => entry.selector.route === "repository-config")).toBe(true)
        const sql = new Database(assertWorking(token).profile.database, { readonly: true })
        try {
          const restored = snapshot.parse({
            ...base,
            id: crypto.randomUUID(),
            createdAt: Date.now(),
            workspaces: [mapped],
            sql: tables.map((table) => ({
              table,
              columns: sql
                .query<{ name: string }, []>(`PRAGMA table_info('${table}')`)
                .all()
                .map((column) => column.name),
              rows: sql.query(`SELECT * FROM "${table}"`).values(),
            })),
            json: [
              {
                path: "raya/agent.json",
                value: await readFile(path.join(lookup(token, path.join(dir, "storage")), "raya/agent.json"), "utf8"),
              },
            ],
            artifacts: await collect(token, { data: dir, workspaces: [mapped] }),
            restoredArtifacts: restoredGitValues(token, proof),
            disposition: collectDisposition(
              token,
              [],
              "selected",
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              proof,
            ),
          })
          return payload.parse({ ...restored, archives })
        } finally {
          sql.close()
        }
      })
      expect(next.restoredArtifacts!.length).toBeGreaterThan(0)
      expect(next.archives.length).toBe(hop)
      expect(payload.safeParse({ ...next, archives: [] }).success).toBe(false)
      value = next
    }
    await writeFile(
      path.join(root, "receipt.json"),
      JSON.stringify(
        {
          format: "raya.restored-git-public-import-proof",
          imports: 3,
          exports: "held component readers, not protected Source export",
          archives: value.archives.length,
          projections: value.restoredArtifacts!.length,
          noReplay: true,
          portableCaptureAuthorized: false,
        },
        null,
        2,
      ),
    )
  },
  180000,
)
