import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { MarkdownIntent } from "@opencode-ai/core/kilocode/config-intent-schema"
import { projectMarkdown, markdownDigest } from "@opencode-ai/core/kilocode/config-markdown-schema"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { capture } from "../../src/kilocode/migration/profile-config"
import { select } from "../../src/kilocode/migration/profile-selection"
import { withWorking, type Working } from "../../src/kilocode/migration/profile-image"
import {
  bindConfig,
  configGroups,
  validateConfig,
  type ConfigClaim,
} from "../../src/kilocode/migration/profile-config-correspondence"
import { collectDisposition } from "../../src/kilocode/migration/profile-disposition"
import { payload, seal, unseal } from "../../src/kilocode/migration/profile-bundle"

test.skipIf(process.platform !== "win32")(
  "held configuration codec preserves inert safe intent and rejects same-byte source rebinding",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-held-config-")))
    const data = path.join(root, "data")
    const storage = path.join(data, "storage")
    await mkdir(storage, { recursive: true })
    const database = path.join(data, "raya.db")
    const db = new Database(database)
    db.exec("CREATE TABLE evidence(value TEXT)")
    db.close()
    const file = path.join(data, "kilo.jsonc")
    const text =
      '// café 日本語 😀\n{"model":"provider/selected","permission":"allow","provider":{"local":{"options":{"apiKey":"SYNTHETIC_CONFIG_SENTINEL"}}}}'
    await writeFile(file, text)
    const info = await lstat(file, { bigint: true })
    const auth = path.join(data, "auth.json")
    await writeFile(auth, text)
    const authinfo = await lstat(auth, { bigint: true })
    const sum = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")
    const unsupported = path.join(data, "unknown-config.json")
    const extra = '{"privatePluginPreference":"unaccounted-nonempty"}'
    await writeFile(unsupported, extra)
    const stamp = await lstat(unsupported, { bigint: true })
    const markdown = path.join(data, "portable.md")
    const content = "---\ndescription: Review only\npermission: allow\n---\nKeep café 日本語 😀 inert."
    await writeFile(markdown, content)
    const pin = await lstat(markdown, { bigint: true })
    const graph = MarkdownIntent.parse({
      format: "raya.config-intent",
      version: 2,
      graph: randomUUID(),
      parser: "v2",
      roots: { data, config: data, state: storage },
      directory: data,
      documents: [
        {
          path: file,
          digest: sum(text),
          bytes: Buffer.byteLength(text),
          identity: { dev: info.dev.toString(), ino: info.ino.toString() },
          safe: { model: "provider/selected" },
          excluded: [
            { field: "permission", reason: "credential-or-execution" },
            { field: "provider", reason: "credential-or-execution" },
          ],
        },
      ],
      reviewOnly: true,
      activation: "held",
      coverage: "loaded-json-and-markdown-config-only",
      markdown: [
        {
          path: markdown,
          digest: sum(content),
          bytes: Buffer.byteLength(content),
          identity: { dev: pin.dev.toString(), ino: pin.ino.toString() },
          kind: "command",
          name: "portable",
          trusted: true,
          order: 0,
          projection: markdownDigest(projectMarkdown(content)),
        },
      ],
      completeProfileCoverage: false,
      portableCaptureAuthorized: false,
    })
    const policy = { version: 1 as const, directories: [data], files: [] }
    const selected = {
      ...(await select({ database, storage }, policy)),
      globals: [
        {
          data,
          config: data,
          cache: data,
          state: storage,
          stateParent: data,
          bin: data,
          log: data,
          repos: data,
          homeKilocode: data,
          homeConfigKilo: data,
        },
      ],
    }
    const selection = {
      ...selected,
      roots: [
        ...selected.roots,
        { kind: "json" as const, path: file },
        { kind: "json" as const, path: markdown },
        { kind: "json" as const, path: unsupported },
        { kind: "json" as const, path: auth },
      ],
    }
    const built = await realpath(
      path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe"),
    )
    const executable = path.join(root, "raya-process-host.exe")
    await copyFile(built, executable)
    const digest = sum(await readFile(executable))
    const input = {
      roots: selection.roots,
      policy,
      helper: { executable, digest },
      registry: path.join(root, "registry"),
    }
    const saved: { token?: Working; claim?: ConfigClaim } = {}
    await withImage(input, async (image) =>
      withWorking(image, selection, async (token) => {
        saved.token = token
        const evidence = await capture(token, [graph])
        const claim = await bindConfig(token, evidence)
        saved.claim = claim
        const groups = configGroups(token, claim)
        const incomplete = MarkdownIntent.parse({
          ...graph,
          graph: randomUUID(),
          markdown: [],
          documents: [
            {
              path: unsupported,
              digest: sum(extra),
              bytes: Buffer.byteLength(extra),
              identity: { dev: stamp.dev.toString(), ino: stamp.ino.toString() },
              safe: {},
              excluded: [{ field: "privatePluginPreference", reason: "unsupported" }],
            },
          ],
        })
        const unknown = await capture(token, [incomplete])
        await assert.rejects(bindConfig(token, unknown), /unsupported fields/)
        const partial = await bindConfig(token, unknown, "selected")
        expect(configGroups(token, partial)).toHaveLength(0)
        const mixed = await bindConfig(token, await capture(token, [graph, incomplete]), "selected")
        expect(configGroups(token, mixed).map((entry) => entry.source)).toEqual([file])
        expect(
          collectDisposition(token, [], "selected", undefined, mixed).files.find((entry) => entry.path === unsupported)
            ?.disposition.kind,
        ).toBe("unclassified")
        const unresolved = collectDisposition(token, [], "selected", undefined, partial)
        expect(unresolved.files.find((entry) => entry.path === unsupported)?.disposition.kind).toBe("unclassified")
        const retained = payload.parse({
          format: "raya.profile-data",
          version: 1,
          id: randomUUID(),
          createdAt: Date.now(),
          schema: "a".repeat(64),
          workspaces: [],
          sql: [],
          json: [],
          config: unknown,
          disposition: unresolved,
          review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
        })
        const archived = await unseal(
          await seal(retained, "unknown configuration private key"),
          "unknown configuration private key",
        )
        expect(archived.config!.graphs[0].documents[0].excluded).toEqual([
          { field: "privatePluginPreference", reason: "unsupported" },
        ])
        assert.throws(() => collectDisposition(token, [], "strict-full", undefined, partial), /incomplete/)
        expect(groups).toHaveLength(1)
        expect(Object.isFrozen(groups[0].excluded)).toBe(true)
        expect(groups[0]).toMatchObject({
          source: file,
          sourceDigest: sum(text),
          rawBytesPreserved: false,
          historicalIntent: "inert",
          activation: "held",
        })
        validateConfig(groups[0], evidence)
        assert.throws(() => configGroups(token, {}), /binding is absent/)
        assert.throws(
          () => validateConfig({ ...groups[0], sourceDigest: "f".repeat(64) }, evidence),
          /current origin differs/,
        )
        assert.throws(
          () => validateConfig({ ...groups[0], projection: "f".repeat(64) }, evidence),
          /safe projection differs/,
        )
        assert.throws(() => validateConfig({ ...groups[0], digest: "f".repeat(64) }, evidence), /component differs/)
        const ledger = collectDisposition(token, [], "selected", undefined, claim)
        const authgraph = MarkdownIntent.parse({
          ...graph,
          graph: randomUUID(),
          markdown: [],
          documents: [
            {
              ...graph.documents[0],
              path: auth,
              identity: { dev: authinfo.dev.toString(), ino: authinfo.ino.toString() },
            },
          ],
        })
        const authclaim = await bindConfig(token, await capture(token, [authgraph]))
        expect(
          collectDisposition(token, [], "selected", undefined, authclaim).files.find((entry) => entry.path === auth)
            ?.disposition.kind,
        ).toBe("credential-omission")
        expect(ledger.files.find((entry) => entry.path === file)?.disposition.kind).toBe("config-semantic")
        expect(ledger.files.find((entry) => entry.path === markdown)?.disposition.kind).toBe("unclassified")
        expect(ledger.incomplete).toContain("unclassified-files")
        assert.throws(() => collectDisposition(token, [], "strict-full", undefined, claim), /incomplete/)
        const content = payload.parse({
          format: "raya.profile-data",
          version: 1,
          id: randomUUID(),
          createdAt: Date.now(),
          schema: "a".repeat(64),
          workspaces: [],
          sql: [],
          json: [],
          config: evidence,
          disposition: ledger,
          review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
        })
        const first = await unseal(
          await seal(content, "held config first private key"),
          "held config first private key",
        )
        const second = await unseal(
          await seal(first, "held config second private key"),
          "held config second private key",
        )
        expect(second.config).toEqual(evidence)
        expect(second.disposition).toEqual(ledger)
        expect(JSON.stringify(second)).not.toContain("SYNTHETIC_CONFIG_SENTINEL")
        const tampered = structuredClone(second)
        tampered.config!.graphs[0].documents[0].safe.model = "provider/tampered"
        assert.throws(() => payload.parse(tampered), /Configuration correspondence component differs/)
        expect(evidence.graphs[0].documents[0].safe).toEqual({ model: "provider/selected" })
        expect(evidence).toMatchObject({
          reviewOnly: true,
          activation: "held",
          completeProfileCoverage: false,
          portableCaptureAuthorized: false,
        })
        expect(JSON.stringify(evidence)).not.toContain("SYNTHETIC_CONFIG_SENTINEL")
        expect(Object.isFrozen(evidence.graphs[0].documents[0].safe)).toBe(true)
        expect(evidence.version).toBe(2)
        if (evidence.version !== 2) throw new Error("Markdown evidence version differs")
        expect(evidence.markdown[0].value.body).toBe("Keep café 日本語 😀 inert.")
        expect(evidence.markdown[0].value.excluded).toContainEqual({
          field: "permission",
          reason: "credential-or-execution",
        })
        const forged = { ...graph, markdown: graph.markdown.map((entry) => ({ ...entry, projection: "f".repeat(64) })) }
        await assert.rejects(capture(token, [forged]), /Markdown staged projection differs/)
        const changed = {
          ...graph,
          documents: graph.documents.map((document) => ({ ...document, safe: { model: "provider/forged" } })),
        }
        await assert.rejects(capture(token, [changed]), /projection differs/)
        const undeclared = {
          ...graph,
          documents: graph.documents.map((document) => ({ ...document, path: path.join(data, "undeclared.json") })),
        }
        await assert.rejects(capture(token, [undeclared]), /exact declared/)
      }),
    )
    expect(saved.token).toBeDefined()
    if (!saved.token) throw new Error("Actual held token was not retained")
    if (!saved.claim) throw new Error("Actual held config claim was not retained")
    assert.throws(() => configGroups(saved.token!, saved.claim!), /expired/)
    await assert.rejects(capture(saved.token, [graph]), /expired/)
    expect(sum(await readFile(file))).toBe(graph.documents[0].digest)
    await rename(file, file + ".old")
    await writeFile(file, text)
    expect((await lstat(file, { bigint: true })).ino).not.toBe(info.ino)
    await withImage(input, async (image) =>
      withWorking(image, selection, async (token) => {
        assert.throws(() => configGroups(token, saved.claim!), /another image/)
        await assert.rejects(capture(token, [graph]), /held source object differs/)
      }),
    )
    await writeFile(
      path.join(root, "receipt.json"),
      JSON.stringify({
        passed: true,
        sourceWriter: "synthetic-real-filesystem",
        capture: "actual-held-native-image-codec",
        compiledProducer: false,
        secretInEvidence: false,
        fullCoverage: false,
        helper: digest,
      }),
    )
  },
  30000,
)
