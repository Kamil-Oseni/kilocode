import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import z from "zod"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import {
  bindComposer,
  composerGroups,
  validateComposer,
  type ComposerClaim,
} from "../../src/kilocode/migration/profile-composer-correspondence"
import { collectComposers } from "../../src/kilocode/migration/profile-composers"
import { assertWorking, withWorking, type Working } from "../../src/kilocode/migration/profile-image"
import { select } from "../../src/kilocode/migration/profile-selection"
import { filename } from "../../src/kilocode/migration/profile-bundle"

test("portable composer pair has exact file selectors without a generic namespace", () => {
  for (const file of ["raya/composer-drafts.json", "raya/composer-drafts-initialized.json"])
    expect(filename.safeParse(file).success).toBe(true)
  expect(filename.safeParse("raya/composer-drafts/unknown.json").success).toBe(false)
  expect(filename.safeParse("raya/composer-drafts-initialized/unknown.json").success).toBe(false)
})

test.skipIf(process.platform !== "win32")(
  "actual encrypted composer restores bind current and stale legacy documents without adopting SQL owners",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-composer-correspondence-")))
    const home = path.join(root, "private")
    await mkdir(home)
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !/^(OTEL_|KILO_|RAYA_|XDG_)|API_KEY|TOKEN|SECRET|PASSWORD/i.test(name),
      ),
    )
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fixtures/profile-composers-restore.ts"), root],
      {
        env: {
          ...env,
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
        },
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    )
    const state = { forced: false }
    const timer = setTimeout(() => {
      state.forced = true
      child.kill()
    }, 65000)
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    clearTimeout(timer)
    await writeFile(path.join(root, "writer-stdout.log"), stdout)
    await writeFile(path.join(root, "writer-stderr.log"), stderr)
    expect(code, stderr).toBe(0)
    expect(state.forced).toBe(false)
    expect(stdout).toContain("COMPOSER_RESTORE_PASS")
    const helper = path.join(root, "raya-process-host.exe")
    await copyFile(path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe"), helper)
    const digest = createHash("sha256")
      .update(await readFile(helper))
      .digest("hex")
    const retained: { token?: Working; proof?: ComposerClaim } = {}
    for (const name of ["first", "second", "stale"]) {
      const data = path.join(root, name === "stale" ? "second" : name, "data/kilo"),
        storage = path.join(data, "storage")
      if (name === "stale") {
        // Reuse exact genuine first-restore bytes as a separate stale-file fixture; do not reopen its runtime.
        for (const file of ["composer-drafts.json", "composer-drafts-initialized.json"])
          await copyFile(path.join(root, "first/data/kilo/storage/raya", file), path.join(storage, "raya", file))
      }
      const policy = { version: 1 as const, directories: [data], files: [] }
      const selected = await select({ database: path.join(data, "raya.db"), storage }, policy)
      const roles = {
        data,
        config: data,
        cache: data,
        state: data,
        stateParent: data,
        bin: data,
        log: data,
        repos: data,
        homeKilocode: data,
        homeConfigKilo: data,
      }
      await withImage(
        {
          roots: selected.roots,
          policy,
          helper: { executable: helper, digest },
          registry: path.join(root, "control", name),
        },
        (image) =>
          withWorking(image, { ...selected, globals: [roles] }, async (token) => {
            const current = assertWorking(token)
            const db = new Database(current.profile.database, { readonly: true })
            const tables = (() => {
              try {
                return ["raya_composer_control", "raya_composer_draft"].map((table) => ({
                  table,
                  columns: z
                    .array(z.object({ name: z.string() }))
                    .parse(db.query(`PRAGMA table_info("${table}")`).all())
                    .map((item) => item.name),
                  rows: z
                    .array(z.array(z.union([z.string(), z.number(), z.null()])))
                    .parse(db.query(`SELECT * FROM "${table}"`).values()),
                }))
              } finally {
                db.close()
              }
            })()
            const json = await Promise.all(
              ["raya/composer-drafts.json", "raya/composer-drafts-initialized.json"].map(async (file) => ({
                path: file,
                value: await readFile(path.join(current.profile.storage, ...file.split("/")), "utf8"),
              })),
            )
            const component = { json, composers: await collectComposers(tables, current.profile.storage), sql: tables }
            const proof = await bindComposer(token, component)
            retained.token = token
            retained.proof = proof
            const groups = composerGroups(token, proof)
            if (name === "second") {
              // Genuine boot retires both files into proofs of this exact held SQL journal; they remain inert evidence.
              expect(JSON.parse(json[0].value).version).toBe(2)
            }
            expect(groups).toHaveLength(2)
            for (const entry of groups) {
              validateComposer(entry, component)
              expect(entry.activation).toBe("inert")
              expect(entry.relation).toBe(
                name === "first" ? "current-content" : name === "second" ? "retired-sql-control" : "inert-historical",
              )
            }
            const changed = structuredClone(component)
            changed.json[0].value += " "
            await assert.rejects(bindComposer(token, changed), /held native bytes/)
            expect(() => validateComposer(groups[0], changed)).toThrow("component differs")
            expect(() =>
              validateComposer({ ...groups[0], source: path.join(root, "foreign.json") }, component),
            ).toThrow("original bytes")
            expect(() => composerGroups(token, JSON.parse(JSON.stringify(proof)))).toThrow("another image")
            if (name === "second") {
              const journal = structuredClone(component)
              const control = journal.sql.find((table) => table.table === "raya_composer_control")!
              control.rows[0][control.columns.indexOf("source_digest")] = "0".repeat(64)
              await assert.rejects(bindComposer(token, journal), /journal differs/)
              expect(() => validateComposer(groups[0], journal)).toThrow("component differs")
              const invalid = structuredClone(component)
              const row = invalid.sql.find((table) => table.table === "raya_composer_control")!
              row.rows[0][row.columns.indexOf("metadata_bytes")] = 0
              const digest = createHash("sha256").update(JSON.stringify(invalid)).digest("hex")
              expect(() => validateComposer({ ...groups[0], componentDigest: digest }, invalid)).toThrow(
                "relation differs",
              )
            }
            if (name === "stale") {
              const unknown = structuredClone(component)
              unknown.json[1].value = '{"version":1,"unknown":true}'
              expect(composerGroups(token, await bindComposer(token, unknown))).toHaveLength(0)
            }
            await assert.rejects(writeFile(path.join(storage, "foreign.json"), "refused"))
          }),
      )
      expect(() => composerGroups(retained.token!, retained.proof!)).toThrow("expired")
    }
  },
  100000,
)
