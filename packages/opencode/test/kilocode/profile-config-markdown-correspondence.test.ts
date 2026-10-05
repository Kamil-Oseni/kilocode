import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Database } from "bun:sqlite"
import { SourceScopes } from "@opencode-ai/core/kilocode/source-scopes"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { capture } from "../../src/kilocode/migration/profile-config"
import {
  configMarkdown,
  bindMarkdown,
  markdownGroups,
  validateMarkdown,
  type MarkdownClaim,
} from "../../src/kilocode/migration/profile-config-markdown-correspondence"
import { origin, withWorking, type Working } from "../../src/kilocode/migration/profile-image"
import { select } from "../../src/kilocode/migration/profile-selection"
import { collectDisposition } from "../../src/kilocode/migration/profile-disposition"
import { seal, snapshot, unseal } from "../../src/kilocode/migration/profile-bundle"
import { withTimeout } from "../../src/util/timeout"
test.skipIf(process.platform !== "win32")(
  "actual loaded Markdown claims bind native origins and safe inert projection without raw credentials",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-config-markdown-")))
    const env = { ...process.env }
    for (const name of Object.keys(env))
      if (/^(?:OTEL_|RAYA_|KILO_|OPENCODE_|GIT_)|(?:API_KEY|TOKEN|SECRET)$/.test(name)) delete env[name]
    Object.assign(env, {
      HOME: root,
      USERPROFILE: root,
      KILO_TEST_HOME: root,
      LOCALAPPDATA: path.join(root, "local"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      RAYA_DB: path.join(root, "data/kilo/raya.db"),
      KILO_DB: path.join(root, "data/kilo/raya.db"),
      RAYA_AUTH_CONTENT: "{}",
      KILO_AUTH_CONTENT: "{}",
      RAYA_MARKDOWN_PRIVATE: "SYNTHETIC_MARKDOWN_EXPANDED_PRIVATE",
      KILO_DISABLE_MODELS_FETCH: "1",
      KILO_DISABLE_AUTOUPDATE: "1",
    })
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        "--conditions=browser",
        path.join(import.meta.dir, "fixtures/profile-config-markdown.ts"),
        root,
      ],
      { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
    )
    const out = new Response(child.stdout).text(),
      err = new Response(child.stderr).text()
    try {
      const result = await withTimeout(Promise.all([child.exited, out, err]), 30000, "Markdown loader deadline")
      await writeFile(path.join(root, "writer.stderr.log"), result[2])
      assert.equal(result[0], 0, result[2])
      expect(result[1]).toContain("LOADED_MARKDOWN_SCOPE_READY")
      expect(() => process.kill(child.pid, 0)).toThrow()
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
      await Promise.all([child.exited, out, err])
    }
    const scopes = SourceScopes.parse(JSON.parse(await readFile(path.join(root, "scope-proof.json"), "utf8")))
    assert(scopes.version === 4 && scopes.configStatus === "complete")
    const graph = scopes.configs[0],
      data = graph.roots.data,
      storage = path.join(data, "storage")
    await mkdir(storage, { recursive: true })
    const database = path.join(data, "raya.db"),
      db = new Database(database)
    db.exec("CREATE TABLE evidence(value TEXT)")
    db.close()
    const policy = { version: 1 as const, directories: [root], files: [] }
    const selected = await select({ database, storage }, policy)
    const files = graph.markdown.map((item) => ({ kind: "json" as const, path: item.path }))
    const selection = {
      ...selected,
      roots: [
        ...new Map(
          [
            ...selected.roots,
            ...files,
            ...scopes.globals.flatMap((roles) =>
              Object.values(roles).map((file) => ({ kind: "json" as const, path: file })),
            ),
          ].map((root) => [root.kind + ":" + root.path.toLowerCase(), root]),
        ).values(),
      ],
      globals: scopes.globals,
    }
    const helper = path.join(root, "raya-process-host.exe")
    await copyFile(
      process.env.RAYA_MARKDOWN_FIXTURE_HELPER ??
        path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe"),
      helper,
    )
    await mkdir(path.join(root, "registry"))
    const input = {
      roots: selection.roots,
      policy,
      helper: {
        executable: helper,
        digest: createHash("sha256")
          .update(await readFile(helper))
          .digest("hex"),
      },
      registry: path.join(root, "registry"),
    }
    const retained: { token?: Working; claim?: MarkdownClaim; evidence?: unknown } = {}
    await withImage(input, (image) =>
      withWorking(image, selection, async (token) => {
        const evidence = await capture(token, scopes.configs)
        retained.token = token
        retained.evidence = evidence
        const claim = bindMarkdown(token, evidence)
        retained.claim = claim
        const groups = markdownGroups(token, claim)
        expect(groups).toHaveLength(4)
        expect(groups.filter((entry) => entry.bindings.length === 2)).toHaveLength(2)
        const ledger = collectDisposition(
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
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          claim,
        )
        expect(ledger.files.filter((entry) => entry.disposition.kind === "config-markdown")).toHaveLength(4)
        expect(ledger.files.find((entry) => entry.path === path.join(data, "unknown.md"))?.disposition.kind).toBe(
          "unclassified",
        )
        expect(() =>
          collectDisposition(
            token,
            [],
            "strict-full",
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
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            claim,
          ),
        ).toThrow("incomplete")
        for (const entry of groups) {
          validateMarkdown(entry, evidence)
          const native = origin(token, entry.source)
          expect(entry.identity).toEqual({ dev: native.dev, ino: native.ino })
          expect(entry.bytes).toBe(native.bytes)
          expect(entry.sourceDigest).toBe(native.digest)
          expect(entry.rawBytesPreserved).toBe(false)
          expect(Object.isFrozen(entry.bindings)).toBe(true)
          expect(() => validateMarkdown({ ...entry, projection: "0".repeat(64) }, evidence)).toThrow("safe projection")
          expect(() =>
            validateMarkdown(
              { ...entry, bindings: entry.bindings.map((binding) => ({ ...binding, name: "forged" })) },
              evidence,
            ),
          ).toThrow("loader binding")
        }
        expect(groups.some((entry) => entry.source.endsWith("unknown.md"))).toBe(false)
        const rendered = JSON.stringify(evidence)
        for (const value of [
          "SYNTHETIC_MARKDOWN_BODY_PRIVATE",
          "SYNTHETIC_MARKDOWN_OPTIONS_PRIVATE",
          "SYNTHETIC_MARKDOWN_EXPANDED_PRIVATE",
        ])
          expect(rendered).not.toContain(value)
        expect(rendered).toContain("café 日本語 😀")
        expect(groups.some((entry) => entry.excluded.some((field) => field.reason === "recognized-credential"))).toBe(
          true,
        )
        expect(groups.some((entry) => entry.excluded.some((field) => field.reason === "substitution"))).toBe(true)
        expect(() => bindMarkdown(token, JSON.parse(rendered))).toThrow("capture provenance")
        expect(() => markdownGroups(token, JSON.parse(JSON.stringify(claim)))).toThrow("binding is absent")
        const archive = {
          format: "raya.profile-data" as const,
          version: 1 as const,
          id: crypto.randomUUID(),
          createdAt: Date.now(),
          schema: "a".repeat(64),
          workspaces: [],
          sql: [],
          json: [],
          config: evidence,
          disposition: ledger,
          review: { reconnectCredentials: true as const, uncertainWork: "held-no-replay" as const },
        }
        const password = crypto.randomUUID() + crypto.randomUUID()
        const first = await unseal(await seal(archive, password), password)
        const second = await unseal(
          await seal(
            {
              ...archive,
              id: crypto.randomUUID(),
              archives: [
                snapshot.parse(Object.fromEntries(Object.entries(first).filter(([key]) => key !== "archives"))),
              ],
            },
            password,
          ),
          password,
        )
        expect(second.archives[0].config).toEqual(evidence)
        expect(
          second.archives[0].disposition?.files.filter((entry) => entry.disposition.kind === "config-markdown"),
        ).toHaveLength(4)
        for (const entry of groups) {
          expect(
            configMarkdown.safeParse({ ...entry, excluded: [{ field: "pluginPreference", reason: "unsupported" }] })
              .success,
          ).toBe(false)
          expect(
            configMarkdown.safeParse({ ...entry, excluded: [{ field: "model", reason: "invalid-safe-field" }] })
              .success,
          ).toBe(false)
          expect(() =>
            validateMarkdown(
              { ...entry, bindings: entry.bindings.map((binding) => ({ ...binding, order: binding.order + 1 })) },
              evidence,
            ),
          ).toThrow("loader binding")
          expect(() =>
            validateMarkdown(
              { ...entry, bindings: entry.bindings.map((binding) => ({ ...binding, trusted: !binding.trusted })) },
              evidence,
            ),
          ).toThrow("loader binding")
        }
        expect(() => bindMarkdown(token, second.config)).toThrow("capture provenance")
      }),
    )
    expect(() => markdownGroups(retained.token!, retained.claim)).toThrow("expired")
    expect(() => bindMarkdown(retained.token!, retained.evidence)).toThrow("expired")
    await withImage(input, (image) =>
      withWorking(image, selection, async (token) => {
        expect(() => bindMarkdown(token, retained.evidence)).toThrow("another image")
        expect(() => markdownGroups(token, retained.claim)).toThrow("another image")
      }),
    )
  },
  90000,
)
