import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { payload } from "../../src/kilocode/migration/profile-bundle"
import { select } from "../../src/kilocode/migration/profile-selection"
import { withWorking, inventory, type Working } from "../../src/kilocode/migration/profile-image"
import { ReviewSchema, validateRestoredReceipts } from "../../src/kilocode/migration/profile-restore-review-schema"
import { collectDisposition } from "../../src/kilocode/migration/profile-disposition"
import { bindSQL } from "../../src/kilocode/migration/profile-sql-correspondence"
import { allocatorLedger, sqlMetadata } from "../../src/kilocode/migration/profile-sql-metadata"
import { collectStores } from "../../src/kilocode/migration/profile-stores"
import { readHistorical, historicalValues } from "../../src/kilocode/migration/profile-restored-evidence"
import { restoredComponents } from "../../src/kilocode/migration/profile-restored-components-schema"
import {
  bindRestoredComponents,
  restoredComponentGroups,
  restoredComponentValues,
  validateRestoredComponent,
  validateRestoredComponents,
  type RestoredComponentClaim,
} from "../../src/kilocode/migration/profile-restored-components-correspondence"
import {
  bindRestoredSources,
  restoredSourceGroups,
  restoredSourceValues,
  validateRestoredSource,
  validateRestoredSources,
  type RestoredSourceClaim,
} from "../../src/kilocode/migration/profile-restored-source-correspondence"

test.skipIf(process.platform !== "win32")(
  "original-only sidecars bind genuine encrypted restore bytes across two held Global data namespaces",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-restored-components-")))
    const data = path.join(root, "seed café 日本語 😀")
    const storage = path.join(data, "storage")
    await mkdir(storage, { recursive: true })
    const database = path.join(data, "raya.db")
    const home = path.join(root, "home")
    await mkdir(home)
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !/^(RAYA|KILO|OPENCODE|OTEL|GIT)_|API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/.test(name),
      ),
    )
    const isolated = {
      ...env,
      HOME: home,
      USERPROFILE: home,
      KILO_TEST_HOME: home,
      LOCALAPPDATA: path.join(root, "local"),
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      XDG_STATE_HOME: path.join(home, "state"),
      RAYA_DB: path.join(home, "unused.db"),
      KILO_DB: path.join(home, "unused.db"),
      RAYA_AUTH_CONTENT: "{}",
      KILO_AUTH_CONTENT: "{}",
      RAYA_DISABLE_MODELS_FETCH: "1",
      KILO_DISABLE_MODELS_FETCH: "1",
    }
    const seed = Bun.spawn(
      [
        process.execPath,
        "run",
        "--conditions=browser",
        path.join(import.meta.dir, "fixtures/profile-restored-components.ts"),
        root,
        "--seed",
        database,
      ],
      { env: isolated, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
    )
    const [seedcode, seedout, seederr] = await Promise.all([
      seed.exited,
      new Response(seed.stdout).text(),
      new Response(seed.stderr).text(),
    ])
    await writeFile(path.join(root, "seed-stdout.log"), seedout)
    await writeFile(path.join(root, "seed-stderr.log"), seederr)
    expect(seedcode, seederr).toBe(0)
    const seeded = JSON.parse(await readFile(path.join(root, "seed-sql.json"), "utf8"))
    const helper = path.join(root, "raya-process-host.exe")
    assert(process.env.RAYA_TEST_TIMESTAMP_HELPER)
    await copyFile(process.env.RAYA_TEST_TIMESTAMP_HELPER, helper)
    const digest = createHash("sha256")
      .update(await readFile(helper))
      .digest("hex")
    const globals = (data: string) => ({
      data,
      config: data,
      cache: data,
      state: data,
      stateParent: data,
      log: data,
      bin: data,
      repos: data,
      homeKilocode: data,
      homeConfigKilo: data,
    })
    const policy = { version: 1 as const, directories: [data], files: [] }
    const selected = await select({ database, storage }, policy)
    const missing = path.join(data, "historical-missing.db")
    const source = {
      ...selected,
      roots: [...selected.roots, { kind: "sqlite" as const, path: missing }],
      globals: [globals(data)],
    }
    await withImage(
      { roots: source.roots, policy, helper: { executable: helper, digest }, registry: path.join(root, "registry") },
      (image) =>
        withWorking(image, source, async (token) => {
          const claim = await bindSQL(token, { sql: seeded.sql })
          const original = payload.parse({
            format: "raya.profile-data",
            version: 1,
            id: randomUUID(),
            createdAt: Date.now(),
            schema: seeded.schema,
            workspaces: [],
            sql: seeded.sql,
            stores: await collectStores(token, database),
            json: [],
            config: {
              format: "raya.config-review",
              version: 1,
              graphs: [],
              reviewOnly: true,
              activation: "held",
              coverage: "loaded-json-config-only",
              completeProfileCoverage: false,
              portableCaptureAuthorized: false,
            },
            disposition: collectDisposition(token, [], "selected", claim),
            secondary: {
              format: "raya.secondary-data",
              version: 1,
              namespaces: [],
              reviewOnly: true,
              activation: "held",
              coverage: "declared-secondary-data",
              completeProfileCoverage: false,
              portableCaptureAuthorized: false,
            },
            voice: { format: "raya.voice-reconciliation-evidence", version: 1, states: [], activation: "inert" },
            operational: { format: "raya.operational-omission-evidence", version: 1, entries: [], activation: "inert" },
            host: { format: "raya.host-capsule", version: 1, hosts: [] },
            tui: {
              format: "raya.tui-preferences",
              version: 1,
              reviewOnly: true,
              activation: "held",
              scopes: [{ state: data, values: { thinking_visibility: true, theme_mode: "dark" } }],
            },
            notes: { version: 1, plans: [], reverts: [], history: [] },
            outputs: { version: 1, files: [], bindings: [], history: [] },
            selfHeal: { version: 1, records: [], files: [], history: [] },
            exports: {
              format: "raya.session-export-evidence",
              version: 1,
              events: [{
                id: "restored-export-history",
                schema_version: 1,
                session_id: "archived-session",
                root_session_id: "archived-session",
                parent_session_id: null,
                seq: 1,
                request_id: null,
                type: "session_degraded",
                ts: 1700000000000,
                agent_version: "historical",
                data_json: JSON.stringify({ reason: "Unicode history 日本語 😀" }),
                client_scrubbed: 1,
                uploaded_at: null,
                upload_attempts: 0,
                next_attempt_at: null,
              }],
              chunks: [],
            },
            review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
          })
          await writeFile(path.join(root, "input.json"), JSON.stringify(original))
        }),
    )
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        "--conditions=browser",
        path.join(import.meta.dir, "fixtures/profile-restored-components.ts"),
        root,
      ],
      {
        env: {
          ...env,
          HOME: home,
          USERPROFILE: home,
          KILO_TEST_HOME: home,
          LOCALAPPDATA: path.join(root, "local"),
          XDG_DATA_HOME: path.join(home, "data"),
          XDG_CONFIG_HOME: path.join(home, "config"),
          XDG_CACHE_HOME: path.join(home, "cache"),
          XDG_STATE_HOME: path.join(home, "state"),
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
    ])
    clearTimeout(timer)
    await writeFile(path.join(root, "restore-stdout.log"), out)
    await writeFile(path.join(root, "restore-stderr.log"), err)
    expect(deadline.forced).toBe(false)
    expect(code, err).toBe(0)
    assert.throws(() => process.kill(child.pid, 0))
    const restored: { first: string; second: string } = JSON.parse(
      await readFile(path.join(root, "restored.json"), "utf8"),
    )
    const dirs = [restored.first, restored.second]
    const policy2 = { version: 1 as const, directories: dirs, files: [] }
    const selected2 = await select(
      { database: path.join(restored.first, "raya.db"), storage: path.join(restored.first, "storage") },
      policy2,
    )
    const selection = {
      ...selected2,
      roots: [...selected2.roots, { kind: "json" as const, path: restored.second }],
      globals: dirs.map(globals),
    }
    const saved: { token?: Working; claim?: RestoredComponentClaim; original?: RestoredSourceClaim } = {}
    const capture = (body: (token: Working) => Promise<void>) =>
      withImage(
        {
          roots: selection.roots,
          policy: policy2,
          helper: { executable: helper, digest },
          registry: path.join(root, "registry"),
        },
        (image) => withWorking(image, selection, body),
      )
    await capture(async (token) => {
      const reader = await readHistorical(token)
      const archives = historicalValues(token, reader)
      expect(archives.length).toBe(2)
      const original = await bindRestoredSources(token, reader, { archives })
      saved.original = original
      const sources = restoredSourceValues(token, original)
      const records = restoredSourceGroups(token, original)
      expect(sources.length).toBe(2)
      expect(records.length).toBe(2)
      expect(sources.map((value) => value.prior.length).sort((a, b) => a - b)).toEqual([0, 1])
      validateRestoredSources(sources, { archives })
      for (const entry of records) validateRestoredSource(entry, { restoredSources: sources })
      assert.throws(() => restoredSourceGroups(token, JSON.parse(JSON.stringify(original))), /absent|foreign/)
      assert.throws(() => validateRestoredSources(sources, { archives: [] }), /archive/)
      assert.throws(
        () => validateRestoredSource({ ...records[0], digest: "0".repeat(64) }, { restoredSources: sources }),
        /binding differs/,
      )
      const altered = structuredClone(sources)
      altered[0].digest = "0".repeat(64)
      assert.throws(() => validateRestoredSources(altered, { archives }), /writer bytes/)
      await assert.rejects(writeFile(records[0].source, "changed"))
      const claim = await bindRestoredComponents(token, reader, { archives })
      saved.token = token
      saved.claim = claim
      const values = restoredComponentValues(token, claim)
      const groups = restoredComponentGroups(token, claim)
      expect(groups.length).toBe(30)
      expect(values.length).toBe(30)
      assert.deepEqual(
        [...new Set(values.map((item) => item.selector))].sort(),
        [
          "config",
          "disposition",
          "secondary",
          "voice",
          "operational",
          "host",
          "tui",
          "preferences",
          "notes",
          "outputs",
          "selfHeal",
          "sqlMetadata",
          "review",
          "stores",
          "exports",
        ].sort(),
      )
      for (const group of groups) {
        const bytes = await readFile(group.source)
        expect(group.bytes).toBe(bytes.length)
        expect(group.digest).toBe(createHash("sha256").update(bytes).digest("hex"))
      }
      const metadata = values.filter((item) => item.selector === "sqlMetadata")
      expect(metadata.length).toBe(2)
      for (const item of metadata) {
        const value = sqlMetadata.parse(JSON.parse(item.text))
        expect(value.entries[0].allocator.rows).toEqual([{ name: "raya_composer_draft", seq: 1, highwater: 0 }])
        expect(value.installation).toBe(false)
        const archived = archives.find((archive) => archive.id === item.archive)
        assert(archived)
        assert.equal(JSON.stringify(value), JSON.stringify(allocatorLedger(archived.disposition)))
        assert(archived.disposition)
        const duplicate = {
          ...archived.disposition,
          files: [...archived.disposition.files, ...archived.disposition.files],
        }
        assert.equal(JSON.stringify(allocatorLedger(duplicate)), item.text)
        assert.equal(item.text.includes('"id":'), false)
        const file = archived.disposition.files.find(
          (entry) => entry.disposition.kind === "sqlite-semantic" && entry.disposition.allocator,
        )
        assert(file && file.disposition.kind === "sqlite-semantic" && file.disposition.allocator)
        const rows = file.disposition.allocator.rows.map((row) => ({ ...row, seq: row.seq + 1 }))
        const altered = {
          ...file,
          disposition: {
            ...file.disposition,
            allocator: {
              ...file.disposition.allocator,
              rows,
              digest: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
            },
          },
        }
        assert.throws(
          () => allocatorLedger({ ...archived.disposition!, files: [...archived.disposition!.files, altered] }),
          /conflicting metadata/,
        )
      }
      expect(allocatorLedger()).toBeUndefined()
      expect(sqlMetadata.safeParse({ ...JSON.parse(metadata[0].text), entries: [] }).success).toBe(false)
      expect(values.find((item) => item.selector === "disposition")!.text.includes("日本語")).toBe(true)
      validateRestoredComponents(values, { archives })
      const exported = values.filter((value) => value.selector === "exports")
      expect(exported.length).toBe(2)
      for (const value of exported) {
        const altered = values.map((item) => item === value
          ? { ...item, text: item.text.replace("Unicode history", "Changed history") }
          : item)
        assert.throws(() => validateRestoredComponents(altered, { archives }), /projection differs/)
      }
      validateRestoredReceipts(
        values.map((value) => value.context),
        inventory(token).files,
      )
      const tampered = structuredClone(values)
      const context = tampered.find((value) => value.selector === "review")?.context
      assert(context)
      context.receipt.ino = (BigInt(context.receipt.ino) + 1n).toString()
      assert.throws(
        () =>
          validateRestoredReceipts(
            tampered.map((value) => value.context),
            inventory(token).files,
          ),
        /native ledger/,
      )
      for (const entry of groups) validateRestoredComponent(entry, { restoredComponents: values })
      expect(groups.some((item) => item.source.endsWith("restore-source.json"))).toBe(false)
      expect(Object.isFrozen(values[0])).toBe(true)
      assert.throws(() => restoredComponentGroups(token, JSON.parse(JSON.stringify(claim))), /absent|foreign/)
      assert.throws(
        () => validateRestoredComponent({ ...groups[0], digest: "0".repeat(64) }, { restoredComponents: values }),
        /bytes differ/,
      )
      assert.throws(
        () =>
          validateRestoredComponent(
            { ...groups[0], source: path.join(root, "outside.json") },
            { restoredComponents: values },
          ),
        /bytes differ/,
      )
      assert.throws(() => validateRestoredComponents(values, { archives: [] }), /archive/)
      const changed = structuredClone(values)
      changed[0].text = "{}"
      assert.throws(() => validateRestoredComponents(changed, { archives }), /projection differs/)
      expect(restoredComponents.safeParse([{ ...values[0], text: "invalid JSON" }]).success).toBe(false)
      expect(restoredComponents.safeParse([values[0], values[0]]).success).toBe(false)
      expect(
        restoredComponents.safeParse(Array.from({ length: 321 }, () => ({ ...values[0], archive: randomUUID() })))
          .success,
      ).toBe(false)
      await assert.rejects(writeFile(groups[0].source, "changed"))
    })
    assert.throws(() => restoredComponentGroups(saved.token!, saved.claim!), /expired|closed|unavailable/)
    assert.throws(() => restoredSourceGroups(saved.token!, saved.original!), /expired|closed|unavailable/)
    await writeFile(path.join(restored.second, "restore-config.json"), '{"customized":true}')
    await writeFile(path.join(restored.second, "restore-host.json"), '{"customized":true}')
    await writeFile(path.join(restored.second, "restore-sql-metadata.json"), '{"customized":true}')
    await writeFile(path.join(restored.second, "restore-exports.json"), '{"customized":true}')
    const savedReview = ReviewSchema.parse(
      JSON.parse(await readFile(path.join(restored.first, "restore-review.json"), "utf8")),
    )
    await writeFile(
      path.join(restored.first, "restore-review.json"),
      JSON.stringify({
        format: savedReview.format,
        version: 1,
        bundle: savedReview.bundle,
        hold: savedReview.hold,
        workspaces: savedReview.workspaces,
        reconnectCredentials: savedReview.reconnectCredentials,
        uncertainWork: savedReview.uncertainWork,
      }),
    )
    const original = path.join(restored.second, "restore-source.json")
    await writeFile(original, JSON.stringify(JSON.parse(await readFile(original, "utf8")), null, 2))
    await capture(async (token) => {
      assert.throws(() => restoredComponentGroups(token, saved.claim!), /foreign/)
      assert.throws(() => restoredSourceGroups(token, saved.original!), /foreign/)
      const reader = await readHistorical(token)
      const archives = historicalValues(token, reader)
      const claim = await bindRestoredComponents(token, reader, { archives })
      expect(restoredComponentGroups(token, claim).length).toBe(25)
      expect(restoredComponentGroups(token, claim).some(
        (entry) => entry.selector === "exports" && entry.data === restored.second,
      )).toBe(false)
      expect(
        restoredComponentGroups(token, claim).some(
          (entry) => entry.selector === "stores" && entry.data === restored.first,
        ),
      ).toBe(false)
      const source = await bindRestoredSources(token, reader, { archives })
      expect(restoredSourceGroups(token, source).length).toBe(1)
    })
  },
  90000,
)
