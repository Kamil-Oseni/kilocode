import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import {
  MarkdownLineageOrigin,
  MarkdownOrigin,
  markdownDigest,
  projectMarkdown,
} from "@opencode-ai/core/kilocode/config-markdown-schema"
import { LineageIntent, MarkdownIntent } from "@opencode-ai/core/kilocode/config-intent-schema"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { capture, ConfigEvidence } from "../../src/kilocode/migration/profile-config"
import {
  bindMarkdown,
  markdownGroups,
  validateMarkdown,
  type MarkdownClaim,
} from "../../src/kilocode/migration/profile-config-markdown-correspondence"
import { origin, withWorking, type Working } from "../../src/kilocode/migration/profile-image"
import { select } from "../../src/kilocode/migration/profile-selection"
import { seal, snapshot, unseal } from "../../src/kilocode/migration/profile-bundle"

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const file = path.resolve(os.tmpdir(), "raya-markdown-schema.md")
const descriptor = {
  path: file,
  digest: "a".repeat(64),
  bytes: 24,
  identity: { dev: "1", ino: "2" },
  kind: "agent" as const,
  name: "helper",
  trusted: true,
  order: 0,
  projection: "b".repeat(64),
}

test("Markdown lineage preserves legacy schemas and confines history to inert same-loader descriptors", () => {
  expect(MarkdownOrigin.parse(descriptor)).toEqual(descriptor)
  expect(MarkdownLineageOrigin.parse(descriptor)).toEqual(descriptor)
  const current = { ...descriptor, digest: "c".repeat(64), identity: { dev: "1", ino: "3" }, history: [descriptor] }
  expect(MarkdownLineageOrigin.parse(current).history).toEqual([descriptor])
  expect(MarkdownOrigin.safeParse(current).success).toBe(false)
  for (const change of [
    { path: path.resolve(os.tmpdir(), "different.md") },
    { kind: "command" },
    { name: "different" },
    { trusted: false },
    { order: 1 },
    { body: "raw history must not enter metadata" },
    { history: [] },
  ])
    expect(MarkdownLineageOrigin.safeParse({ ...current, history: [{ ...descriptor, ...change }] }).success).toBe(false)
  expect(MarkdownLineageOrigin.safeParse({ ...current, history: Array(64).fill(descriptor) }).success).toBe(true)
  expect(MarkdownLineageOrigin.safeParse({ ...current, history: Array(65).fill(descriptor) }).success).toBe(false)
  const graph = {
    format: "raya.config-intent" as const,
    version: 2 as const,
    graph: randomUUID(),
    parser: "v1" as const,
    roots: { data: path.dirname(file), config: path.dirname(file), state: path.dirname(file) },
    documents: [],
    markdown: [descriptor],
    reviewOnly: true as const,
    activation: "held" as const,
    coverage: "loaded-json-and-markdown-config-only" as const,
    completeProfileCoverage: false as const,
    portableCaptureAuthorized: false as const,
  }
  expect(MarkdownIntent.parse(graph)).toEqual(graph)
  expect(LineageIntent.parse({ ...graph, version: 3 }).markdown).toEqual([descriptor])
  expect(LineageIntent.parse({ ...graph, version: 3, markdown: [current] }).markdown[0].history).toEqual([descriptor])
  expect(MarkdownIntent.safeParse({ ...graph, markdown: [current] }).success).toBe(false)
})

test.skipIf(process.platform !== "win32")(
  "held Markdown capture binds only current atomic replacement while encrypted history remains inert",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-held-markdown-lineage-")))
    const data = path.join(root, "data"),
      storage = path.join(data, "storage")
    await mkdir(storage, { recursive: true })
    const database = path.join(data, "raya.db"),
      db = new Database(database)
    db.exec("CREATE TABLE evidence(value TEXT)")
    db.close()
    const file = path.join(data, "helper.md")
    const first = "---\ndescription: Original café\n---\nOriginal 日本語 😀\n"
    const second = "---\ndescription: Current café\n---\nCurrent 日本語 😀\n"
    await writeFile(file, first)
    const before = await lstat(file, { bigint: true })
    const previous = MarkdownOrigin.parse({
      ...descriptor,
      path: file,
      digest: hash(first),
      bytes: Buffer.byteLength(first),
      identity: { dev: String(before.dev), ino: String(before.ino) },
      projection: markdownDigest(projectMarkdown(first)),
    })
    const temp = path.join(data, "owned-temp.md")
    await writeFile(temp, second, { flag: "wx" })
    await rename(temp, file)
    const after = await lstat(file, { bigint: true })
    expect(after.ino).not.toBe(before.ino)
    const current = MarkdownLineageOrigin.parse({
      ...previous,
      digest: hash(second),
      bytes: Buffer.byteLength(second),
      identity: { dev: String(after.dev), ino: String(after.ino) },
      projection: markdownDigest(projectMarkdown(second)),
      history: [previous],
    })
    const graphs = (["v1", "v2"] as const).map((parser) =>
      LineageIntent.parse({
        format: "raya.config-intent",
        version: 3,
        graph: randomUUID(),
        parser,
        roots: { data, config: data, state: storage },
        directory: data,
        documents: [],
        markdown: [current],
        reviewOnly: true,
        activation: "held",
        coverage: "loaded-json-and-markdown-config-only",
        completeProfileCoverage: false,
        portableCaptureAuthorized: false,
      }),
    )
    const roles = {
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
    }
    const policy = { version: 1 as const, directories: [data], files: [] }
    const selection = {
      ...(await select({ database, storage }, policy)),
      globals: [roles],
      roots: [
        { kind: "sqlite" as const, path: database },
        { kind: "json" as const, path: data },
        { kind: "json" as const, path: storage },
        { kind: "json" as const, path: file },
      ],
    }
    const helper = path.join(root, "raya-process-host.exe")
    await copyFile(path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe"), helper)
    const input = {
      roots: selection.roots,
      policy,
      helper: { executable: helper, digest: hash(await readFile(helper)) },
      registry: path.join(root, "registry"),
    }
    const retained: { token?: Working; claim?: MarkdownClaim; evidence?: unknown } = {}
    await withImage(input, (image) =>
      withWorking(image, selection, async (token) => {
        retained.token = token
        const evidence = await capture(token, graphs)
        retained.evidence = evidence
        assert(evidence.version === 3)
        expect(evidence.graphs.map((graph) => graph.markdown[0].history)).toEqual([[previous], [previous]])
        expect(evidence.markdown.map((entry) => entry.value.body)).toEqual([
          projectMarkdown(second).body,
          projectMarkdown(second).body,
        ])
        const claim = bindMarkdown(token, evidence)
        retained.claim = claim
        const groups = markdownGroups(token, claim)
        expect(groups).toHaveLength(1)
        expect(groups[0].bindings).toHaveLength(2)
        expect(groups[0].sourceDigest).toBe(hash(second))
        expect(groups[0].identity).toEqual({ dev: String(after.dev), ino: String(after.ino) })
        expect(groups[0].identity).toEqual({ dev: origin(token, file).dev, ino: origin(token, file).ino })
        validateMarkdown(groups[0], evidence)
        const altered = structuredClone(evidence)
        altered.graphs[0].markdown[0].history![0].digest = "0".repeat(64)
        expect(() => validateMarkdown(groups[0], altered)).toThrow("component")
        const selector = structuredClone(evidence)
        selector.graphs[0].markdown[0].history![0].trusted = false
        expect(ConfigEvidence.safeParse(selector).success).toBe(false)
        await assert.rejects(
          capture(
            token,
            graphs.map((graph) => ({ ...graph, markdown: [previous] })),
          ),
          /held source object/,
        )
        const value = {
          format: "raya.profile-data" as const,
          version: 1 as const,
          id: randomUUID(),
          createdAt: Date.now(),
          schema: "a".repeat(64),
          workspaces: [],
          sql: [],
          json: [],
          config: evidence,
          review: { reconnectCredentials: true as const, uncertainWork: "held-no-replay" as const },
        }
        const password = randomUUID() + randomUUID()
        const initial = await unseal(await seal(value, password), password)
        const final = await unseal(
          await seal(
            {
              ...value,
              id: randomUUID(),
              archives: [
                snapshot.parse(Object.fromEntries(Object.entries(initial).filter(([key]) => key !== "archives"))),
              ],
            },
            password,
          ),
          password,
        )
        expect(final.config).toEqual(evidence)
        expect(final.archives[0].config).toEqual(evidence)
        expect(() => bindMarkdown(token, final.config)).toThrow("capture provenance")
      }),
    )
    expect(() => markdownGroups(retained.token!, retained.claim)).toThrow("expired")
    await withImage(input, (image) =>
      withWorking(image, selection, async (token) => {
        expect(() => bindMarkdown(token, retained.evidence)).toThrow("another image")
        expect(() => markdownGroups(token, retained.claim)).toThrow("another image")
      }),
    )
    expect(hash(await readFile(file))).toBe(hash(second))
  },
  45000,
)
