/// <reference path="../../../kilo-vscode/src/agent-manager/friendly-words.d.ts" />
import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { copyFile, lstat, mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import z from "zod"
import { Database } from "bun:sqlite"
import { launch } from "@opencode-ai/core/kilocode/source-launch"
import { exportSource } from "@opencode-ai/core/kilocode/source-export"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { ProjectContexts } from "../../../kilo-vscode/src/agent-manager/project/contexts"
import { HostCapture, hostPayload } from "../../../kilo-vscode/src/kilo-provider/host-capture"
import { unseal, payload } from "../../src/kilocode/migration/profile-bundle"
import { disposition } from "../../src/kilocode/migration/profile-disposition"
import { validateHost } from "../../src/kilocode/migration/profile-host-correspondence"
import { validateStorage } from "../../src/kilocode/migration/profile-storage-correspondence"
import { validateMemory } from "../../src/kilocode/migration/profile-memory-correspondence"
import { validateComposer } from "../../src/kilocode/migration/profile-composer-correspondence"
import { DraftSchemas } from "../../src/kilocode/session/composer-codec"
import { MemoryPaths } from "@kilocode/kilo-memory/paths"

test.skipIf(process.platform !== "win32")(
  "actual export producer joins exact private receiver, immutable image and signed encrypted payload",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-source-export-producer-"))
    const evidence = await mkdtemp(path.join(os.tmpdir(), "raya-source-export-witness-"))
    for (const directory of ["home", "state", "data", "config", "cache", "workspace", "storage"])
      await mkdir(path.join(root, directory))
    const local = path.join(root, "home", "AppData", "Local")
    await mkdir(local, { recursive: true })
    const storage = path.join(root, "data", "kilo", "storage")
    await mkdir(storage, { recursive: true })
    await mkdir(path.join(root, "state", "kilo"), { recursive: true })
    // Exact private on-disk fixture data; this does not claim execution of the TUI writer.
    await writeFile(
      path.join(root, "state", "kilo", "kv.json"),
      JSON.stringify({ terminal_title_enabled: false, thinking_visibility: true, theme_mode: "dark" }),
    )
    const file = path.join(root, "data", "kilo", "raya.db")
    const missing = path.join(root, "data", "kilo", "historical-missing.db")
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined &&
          !/^(RAYA|KILO|OPENCODE|OTEL)_/.test(entry[0]) &&
          !/(TOKEN|SECRET|API_KEY)$/.test(entry[0]),
      ),
    )
    Object.assign(env, {
      HOME: path.join(root, "home"),
      USERPROFILE: path.join(root, "home"),
      LOCALAPPDATA: local,
      KILO_TEST_HOME: path.join(root, "home"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      RAYA_DB: file,
      KILO_DB: file,
      RAYA_TEST_HISTORICAL_SQLITE: missing,
      RAYA_TEST_EVIDENCE: evidence,
      RAYA_AUTH_CONTENT: "{}",
      KILO_AUTH_CONTENT: "{}",
      RAYA_DISABLE_MODELS_FETCH: "1",
      KILO_DISABLE_MODELS_FETCH: "1",
    })
    const primary = path.join(root, "workspace")
    const cfg = path.join(root, "config", "kilo")
    await mkdir(cfg, { recursive: true })
    const global = path.join(cfg, "kilo.json")
    const explicit = path.join(root, "config", "explicit.json")
    const project = path.join(primary, "kilo.jsonc")
    const documents = [
      {
        file: global,
        text: JSON.stringify({
          model: "synthetic/global",
          default_agent: "build",
          permission: "deny",
          provider: { synthetic: { options: { apiKey: "SYNTHETIC_CONFIG_SENTINEL" } } },
        }),
      },
      {
        file: explicit,
        text: JSON.stringify({
          model: "synthetic/explicit",
          small_model: "{env:RAYA_CONFIG_INTENT_MODEL}",
        }),
      },
      {
        file: project,
        text: "// café 日本語 😀\n" + JSON.stringify({ model: "synthetic/project" }),
      },
    ]
    for (const document of documents) await writeFile(document.file, document.text)
    for (const kind of ["commands", "agents", "modes"]) await mkdir(path.join(cfg, kind))
    await writeFile(
      path.join(cfg, "commands", "portable.md"),
      "---\ndescription: Inert command: café\nsubtask: true\n---\nPreserve command café 日本語 😀 without dispatch.",
    )
    await writeFile(
      path.join(cfg, "commands", "private.md"),
      "---\ndescription: Recognized credential body\n---\napiKey=SYNTHETIC_MARKDOWN_LITERAL_SENTINEL",
    )
    await writeFile(
      path.join(cfg, "agents", "portable.md"),
      "---\ndescription: Inert agent\npermission: allow\noptions:\n  apiKey: SYNTHETIC_MARKDOWN_SENTINEL\n---\nDo not capture {env:RAYA_MARKDOWN_SENTINEL}",
    )
    await writeFile(
      path.join(cfg, "modes", "portable.md"),
      "---\ncolor: accent\n---\nPreserve mode café 日本語 😀 without activation.",
    )
    env.RAYA_MARKDOWN_SENTINEL = "SYNTHETIC_EXPANDED_MARKDOWN_SENTINEL"
    env.KILO_CONFIG = explicit
    env.RAYA_CONFIG_INTENT_MODEL = "synthetic/unused"
    const managed = path.join(root, "data", "kilo", "worktree", "project", "producer")
    await mkdir(path.dirname(managed), { recursive: true })
    const git = async (...args: string[]) => {
      const child = Bun.spawn(["git", ...args], {
        cwd: primary,
        env: {
          ...env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: path.join(root, "absent-config"),
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "fixture@invalid",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "fixture@invalid",
          GIT_TERMINAL_PROMPT: "0",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      assert.equal(code, 0, stderr)
      return stdout.trim()
    }
    await git("init")
    await writeFile(path.join(primary, "actual.txt"), "committed café 日本語 😀\n")
    await git("add", "actual.txt")
    await git("commit", "-m", "private fixture")
    const memory = MemoryPaths.identity({ ctx: { directory: primary, worktree: primary } })
    const remembered = path.join(root, "data", "kilo", "memory", memory.folder)
    const quarantines = await (
      await import("./fixtures/source-memory-quarantine-assert")
    ).hosted(root, primary, env, evidence)
    await git("worktree", "add", "-b", "producer", managed)
    const dirty = "unsaved worktree café 日本語 😀\n"
    await writeFile(path.join(managed, "actual.txt"), dirty)
    await writeFile(path.join(managed, "untracked.txt"), "private untracked bytes\n")
    const head = await git("rev-parse", "HEAD")
    const state = path.join(root, "state", "historical-model.json")
    const model = { providerID: "qwen-local", modelID: "qwen3-raya-32k" }
    const models = { selected: model, recent: [model], favorite: [model], agents: [{ ...model, agent: "build" }] }
    await writeFile(state, JSON.stringify(models))
    const contexts = new ProjectContexts({
      workspaceRoot: () => primary,
      registry: { list: () => [], get: () => undefined },
      enabled: () => false,
      deps: { log: () => undefined },
    })
    const owner = contexts.pinned()!.stateManager()
    expect((await owner.load()).status).toBe("missing")
    const absent = owner.publications().roots[0].path
    expect(await Bun.file(absent).exists()).toBe(false)
    const hosts = new HostCapture()
    hosts.contexts(contexts)
    const closed = await hosts.capture(createKiloClient({ baseUrl: "http://127.0.0.1:1" }), Date.now() + 5000)
    const metadata = hostPayload(closed)
    expect(metadata.hosts[0].contexts[0].root?.path).toBe(absent)
    const host = {
      format: "raya.host-capsule" as const,
      version: 1 as const,
      hosts: [
        ...metadata.hosts,
        {
          id: crypto.randomUUID(),
          role: "view" as const,
          revision: 1,
          models,
          owners: [{ id: crypto.randomUUID(), revision: 1, root: { kind: "json" as const, path: state }, models }],
          contexts: [{ id: crypto.randomUUID(), path: primary }],
        },
      ],
    }
    const native = await mkdtemp(path.join(os.tmpdir(), "raya-allocator-source-native-"))
    const helper = path.join(native, "raya-process-host.exe")
    await copyFile(
      process.env.RAYA_TEST_DIRECTORY_HELPER ??
        path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe"),
      helper,
    )
    const password = `private-producer-${crypto.randomUUID()}`
    const secret = process.env.RAYA_TEST_SOURCE_PASSWORD_FILE
    if (secret !== undefined) {
      assert(path.isAbsolute(secret) && path.basename(secret) === "archive-password.private")
      const parent = path.dirname(secret)
      assert(path.basename(parent).startsWith("raya-source-quarantine-secret-"))
      const before = await lstat(parent, { bigint: true })
      assert(before.isDirectory() && !before.isSymbolicLink())
      const canonical = await realpath(parent)
      assert.equal(path.win32.normalize(canonical).toLowerCase(), path.win32.normalize(parent).toLowerCase())
      await writeFile(secret, password, { flag: "wx", mode: 0o600 })
      const info = await lstat(secret, { bigint: true })
      assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1n)
      const after = await lstat(parent, { bigint: true })
      assert(after.isDirectory() && !after.isSymbolicLink() && after.dev === before.dev && after.ino === before.ino)
    }
    const session = await launch({
      executable: process.execPath,
      digest: createHash("sha256")
        .update(await Bun.file(process.execPath).bytes())
        .digest("hex"),
      cwd: path.resolve(import.meta.dir, "../.."),
      env,
      helper: {
        executable: helper,
        digest: createHash("sha256")
          .update(await readFile(helper))
          .digest("hex"),
      },
      roots: [{ kind: "json", path: path.join(root, "data", "kilo") }],
      policy: { version: 1, directories: [root], files: [] },
      args: [
        "run",
        "--conditions=browser",
        path.join(import.meta.dir, "fixtures/source-export-historical-entry.ts"),
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        "0",
      ],
      timeout: 60000,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    session.child.stdout?.on("data", (data: Buffer) => stdout.push(data))
    session.child.stderr?.on("data", (data: Buffer) => stderr.push(data))
    const output = path.join(os.tmpdir(), `raya-exported-producer-${crypto.randomUUID()}.raya`)
    const errors: unknown[] = []
    try {
      await session.start()
      const end = Date.now() + 60000
      let url: string | undefined
      while (
        !(url = Buffer.concat(stdout)
          .toString()
          .match(/kilo server listening on (http:\/\/[^\s]+)/)?.[1])
      ) {
        if (Date.now() > end) throw new Error("Actual Serve startup deadline")
        await Bun.sleep(25)
      }
      const response = await fetch(`${url}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-kilo-directory": path.join(root, "workspace") },
        body: JSON.stringify({ title: "export-producer-durable-session" }),
      })
      expect(response.ok).toBe(true)
      const created = z.object({ id: z.string().min(1), projectID: z.string().min(1) }).parse(await response.json())
      const draft = await fetch(`${url}/kilocode/composer-drafts/save?directory=${encodeURIComponent(primary)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-kilo-directory": primary },
        body: JSON.stringify({
          identity: {
            key: `sidebar:new-task:session:${created.id}`,
            box: "sidebar:new-task",
            workspace: primary,
            projectID: created.projectID,
            sessionID: created.id,
          },
          content: { text: "SOURCE_COMPOSER_UNSENT café 日本語 😀", comments: [], images: [], scroll: 0 },
          mutation: "source-composer-native-correspondence",
        }),
      })
      expect(draft.ok).toBe(true)
      const unsent = z.object({ entry: DraftSchemas.entry }).parse(await draft.json()).entry
      for (const [route, body] of [
        ["goal", { objective: "SOURCE_GOAL café 日本語 😀" }],
        ["checkpoint", { name: "SOURCE_CHECKPOINT café 日本語 😀" }],
      ] as const) {
        const response = await fetch(`${url}/session/${created.id}/${route}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-kilo-directory": primary },
          body: JSON.stringify(body),
        })
        expect(response.ok).toBe(true)
        const value: unknown = await response.json()
        expect(value).toBeDefined()
      }
      const configured = await fetch(`${url}/config?directory=${encodeURIComponent(primary)}`, {
        headers: { "x-kilo-directory": primary },
      })
      expect(configured.ok).toBe(true)
      const effective = z.object({ model: z.string(), small_model: z.string() }).parse(await configured.json())
      expect(effective).toEqual({ model: "synthetic/project", small_model: "synthetic/unused" })
      const published = await Promise.all(documents.map((document) => readFile(document.file, "utf8")))
      for (const [index, text] of published.entries()) {
        expect(text).not.toBe(documents[index].text)
        expect(text).toContain('"$schema"')
      }
      const historical = z
        .object({
          closed: z.literal(true),
          roots: z.array(z.object({ kind: z.string(), path: z.string() })),
        })
        .parse(JSON.parse(await Bun.file(path.join(evidence, "historical-sqlite.json")).text()))
      expect(
        historical.roots.some((root) => root.kind === "sqlite" && root.path.toLowerCase() === missing.toLowerCase()),
      ).toBe(true)
      const input = {
        profile: { database: file, storage },
        password,
        output,
        host,
      }
      const pending = exportSource(session, input)
      expect(exportSource(session, input)).toBe(pending)
      await assert.rejects(
        exportSource(session, { ...input, password: password + "changed" }),
        /changed after acceptance/,
      )
      const result = await pending
      expect(result.result.status).toBe("exported")
      expect(result.result.artifact?.output).toBe(output)
      expect(result.result.completeProfileCoverage).toBe(false)
      expect(result.result.portableCaptureAuthorized).toBe(false)
      expect(result.code).toBe(0)
      expect(result.family.familyZeroObserved).toBe(true)
      expect((await session.sourceExit).code).toBe(0)
      expect((await session.exit).code).toBe(0)
      expect(await Bun.file(output).exists()).toBe(true)
      const bundle = await unseal(await Bun.file(output).text(), password)
      const ready = await Bun.file(`${session.ticket.control}.source-handoff-ready`).json()
      const ack = await Bun.file(path.join(ready.value.successor.control, "ack.json")).json()
      assert.equal(bundle.disposition?.directoryCoverage, "verified")
      for (const [dir, name] of [
        [path.join(root, "cache", "kilo"), "models.json"],
        [path.join(root, "data", "kilo"), "auth.json"],
        [path.join(root, "data", "kilo"), "auth.json.raya-intent.json"],
      ]) {
        assert(
          ack.value.roots.roots.some(
            (entry: { kind: string; path: string }) =>
              entry.kind === "json" && entry.path.toLowerCase() === path.join(dir, name).toLowerCase(),
          ),
        )
        const evidence = bundle.disposition?.directories?.find(
          (entry) => entry.path.toLowerCase() === dir.toLowerCase(),
        )
        assert(evidence, "Actual held parent directory required")
        assert(
          !evidence.children.some((entry) => entry.name.toLowerCase() === name.toLowerCase()),
          "Actual held child inventory must prove acknowledged absence",
        )
      }
      expect(
        bundle.disposition?.files.some((entry) => entry.path.toLowerCase().startsWith(evidence.toLowerCase())),
      ).toBe(false)
      expect(
        bundle.disposition?.files.some((entry) => /(?:allocator-fixture|fixture-receipt)\.json$/.test(entry.path)),
      ).toBe(false)
      const integrated = await (
        await import("./fixtures/source-integrated-correspondence-assert")
      ).assertIntegratedSource(bundle)
      const counters = (await import("./fixtures/source-sql-allocator-assert")).assertAllocatorSource(bundle)
      const seeded = await Bun.file(path.join(evidence, "allocator.json")).json()
      expect(seeded.rows[0].seq).toBeGreaterThan(seeded.highwater)
      const counter = new Database(file, { readonly: true, strict: true })
      try {
        const actual = (await import("../../src/kilocode/migration/profile-sql-allocator")).captureAllocator(
          counter,
          counters.schema,
        )
        assert(actual)
        expect(counters.rows).toEqual(actual.rows)
        expect(counters.rows[0].seq).toBeGreaterThanOrEqual(seeded.rows[0].seq)
      } finally {
        counter.close()
      }
      const operational = (await import("./fixtures/source-operational-assert")).verifyOperational(bundle)
      expect(bundle.composers?.entries).toContainEqual(unsent)
      const composerClaims = bundle.disposition.files.filter((entry) => entry.disposition.kind === "composer-json")
      expect(composerClaims).toHaveLength(2)
      for (const entry of composerClaims) {
        if (entry.disposition.kind !== "composer-json") throw new Error("Actual composer correspondence missing")
        validateComposer(entry.disposition, bundle)
        expect(entry.disposition.relation).toBe("retired-sql-control")
        const info = await lstat(entry.path, { bigint: true })
        expect(entry.dev).toBe(info.dev.toString())
        expect(entry.ino).toBe(info.ino.toString())
        expect(entry.digest).toBe(
          createHash("sha256")
            .update(await readFile(entry.path))
            .digest("hex"),
        )
      }
      const composerTamper = structuredClone(bundle)
      composerTamper.composers!.entries[0].content!.text += "changed"
      expect(payload.safeParse(composerTamper).success).toBe(false)
      const derived = await (
        await import("./fixtures/source-memory-derived-assert")
      ).assertMemoryDerivedSource(bundle, true)
      await (await import("./fixtures/source-host-model-assert")).verifyModels(bundle)
      const seeds = [
        ...Buffer.concat(stdout)
          .toString()
          .matchAll(/^RAYA_VOICE_SEED (\{[^\r\n]{1,1024}\})\r?$/gm),
      ]
      expect(seeds).toHaveLength(1)
      const baseline = z
        .object({ cycle: z.literal(1), status: z.literal("complete"), scanned: z.literal(0), receipts: z.literal(0) })
        .strict()
        .parse(JSON.parse(seeds[0][1]))
      const voice = await (
        await import("./fixtures/source-voice-reconciliation-assert")
      ).verifyVoice(bundle, true, baseline)
      const gitMetadata = await (
        await import("./fixtures/source-git-metadata-assert")
      ).assertGitMetadataSource(bundle, true)
      const storageClaims = bundle.disposition.files.filter((entry) => entry.disposition.kind === "storage-json")
      expect(storageClaims).toHaveLength(5)
      expect(
        new Set(
          storageClaims.map((entry) =>
            entry.disposition.kind === "storage-json" ? entry.disposition.selector.role : "invalid",
          ),
        ).size,
      ).toBe(5)
      for (const entry of storageClaims) {
        if (entry.disposition.kind !== "storage-json") throw new Error("Actual storage JSON correspondence missing")
        validateStorage(entry.disposition, { json: bundle.json })
        const info = await lstat(entry.path, { bigint: true })
        expect(entry.dev).toBe(info.dev.toString())
        expect(entry.ino).toBe(info.ino.toString())
        expect(entry.digest).toBe(
          createHash("sha256")
            .update(await readFile(entry.path))
            .digest("hex"),
        )
        expect(entry.disposition.activation).toBe("inert")
      }
      const storageTamper = structuredClone(bundle)
      storageTamper.json.find((entry) => entry.path === "raya/agent.json")!.value += " "
      expect(payload.safeParse(storageTamper).success).toBe(false)
      expect(bundle.memory).toHaveLength(1)
      expect(bundle.memory[0].sources["project.md"]).toBe("SOURCE_MEMORY_EXACT café 日本語 😀\n")
      const memories = bundle.disposition.files.filter((entry) => entry.disposition.kind === "memory-semantic")
      expect(memories).toHaveLength(6 + quarantines.length)
      expect(
        memories.filter((entry) => entry.disposition.kind === "memory-semantic" && entry.disposition.rawBytesPreserved),
      ).toHaveLength(4 + quarantines.length)
      const quarantine = await (await import("./fixtures/source-memory-quarantine-assert")).current(bundle, quarantines)
      for (const entry of memories) {
        if (entry.disposition.kind !== "memory-semantic") throw new Error("Actual memory correspondence missing")
        validateMemory(entry.disposition, bundle)
        const stat = await lstat(entry.path, { bigint: true })
        expect(entry.dev).toBe(String(stat.dev))
        expect(entry.ino).toBe(String(stat.ino))
        expect(entry.bytes).toBe(Number(stat.size))
        expect(entry.digest).toBe(
          createHash("sha256")
            .update(await readFile(entry.path))
            .digest("hex"),
        )
      }
      expect(
        bundle.disposition.files.find((entry) => entry.path === path.join(remembered, ".gitignore"))?.disposition.kind,
      ).toBe("memory-derived")
      expect(bundle.config).toMatchObject({
        reviewOnly: true,
        activation: "held",
        coverage: "loaded-json-and-markdown-config-only",
        completeProfileCoverage: false,
        portableCaptureAuthorized: false,
      })
      const configuredGraph = bundle.config?.graphs.find((graph) => graph.parser === "v1" && graph.documents.length > 0)
      expect(configuredGraph).toBeDefined()
      expect(configuredGraph?.documents.map((document) => document.path)).toEqual(
        documents.map((document) => document.file),
      )
      expect(configuredGraph?.documents.at(-1)?.safe.model).toBe("synthetic/project")
      expect(configuredGraph?.documents[0].excluded).toContainEqual({
        field: "provider",
        reason: "credential-or-execution",
      })
      expect(configuredGraph?.documents[1].excluded).toContainEqual({ field: "small_model", reason: "substitution" })
      expect(JSON.stringify(bundle.config)).not.toContain("SYNTHETIC_CONFIG_SENTINEL")
      expect(bundle.disposition?.scope).toBe("selected-held-files")
      expect(bundle.disposition?.incomplete).toEqual([])
      expect(bundle.disposition?.directoryCoverage).toBe("verified")
      expect(bundle.disposition?.incomplete).not.toContain("native-directory-inventory-unavailable")
      expect(bundle.disposition?.directories?.length).toBeGreaterThan(0)
      const groups = bundle.disposition.files.filter((entry) => entry.disposition.kind === "git-bytes")
      expect(groups.length).toBeGreaterThan(10)
      expect(
        groups.some(
          (entry) =>
            entry.disposition.kind === "git-bytes" &&
            entry.disposition.selector.kind === "worktree" &&
            entry.disposition.activation === "inert",
        ),
      ).toBe(true)
      expect(groups.some((entry) => entry.path.endsWith(`${path.sep}config`))).toBe(false)
      expect(groups.some((entry) => entry.path.endsWith(`${path.sep}.git`))).toBe(false)
      expect(disposition.safeParse({ ...bundle.disposition, mode: "strict-full" }).success).toBe(true)
      const gitTamper = structuredClone(bundle)
      const metadata = gitTamper.artifacts!.repositories[0].files[0]
      metadata.bytes = Buffer.from("alteredGit").toString("base64")
      metadata.digest = createHash("sha256").update("alteredGit").digest("hex")
      expect(payload.safeParse(gitTamper).success).toBe(false)
      const correspondence = bundle.disposition?.files.find(
        (item) => item.disposition.kind === "sqlite-semantic" && item.disposition.component === "sql",
      )?.disposition
      expect(correspondence?.kind).toBe("sqlite-semantic")
      if (correspondence?.kind !== "sqlite-semantic") throw new Error("Actual SQL correspondence missing")
      expect(correspondence.tables.find((item) => item.table === "migration")).toMatchObject({
        disposition: "inactive-migration-journal",
        rows: 59,
      })
      expect(correspondence.journal?.rows).toHaveLength(59)
      expect(correspondence.journal?.reconstruction).toBe(false)
      const journal = structuredClone(bundle)
      const journaled = journal.disposition!.files.find(
        (item) => item.disposition.kind === "sqlite-semantic" && item.disposition.component === "sql",
      )!.disposition
      if (journaled.kind !== "sqlite-semantic" || !journaled.journal)
        throw new Error("Source migration journal missing")
      journaled.journal.rows[0].time_completed++
      expect(payload.safeParse(journal).success).toBe(false)
      expect(correspondence.rawBytesPreserved).toBe(false)
      expect(correspondence.tables.find((item) => item.table === "credential")).toMatchObject({
        rows: 1,
        disposition: "credential-or-authority-omission",
      })
      expect(correspondence.tables.find((item) => item.table === "session")?.disposition).toBe("selected")
      expect(JSON.stringify(bundle)).not.toContain("SYNTHETIC_SQL_CREDENTIAL_SENTINEL")
      const tampered = structuredClone(bundle)
      tampered.sql.find((item) => item.table === "session")!.rows.push([])
      expect(payload.safeParse(tampered).success).toBe(false)
      const digest = structuredClone(bundle)
      const changed = digest.disposition!.files.find((item) => item.disposition.kind === "sqlite-semantic")!
      if (changed.disposition.kind !== "sqlite-semantic") throw new Error("SQL disposition missing")
      changed.disposition.digest = "0".repeat(64)
      digest.disposition!.fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            roots: digest.disposition!.roots,
            globals: digest.disposition!.globals,
            files: digest.disposition!.files,
            directories: digest.disposition!.directories,
          }),
        )
        .digest("hex")
      expect(payload.safeParse(digest).success).toBe(false)
      expect(bundle.disposition?.files.some((item) => item.disposition.kind === "unclassified")).toBe(false)
      expect(bundle.disposition?.completeProfileCoverage).toBe(false)
      expect(bundle.disposition?.portableCaptureAuthorized).toBe(false)
      expect(JSON.stringify(bundle.disposition)).not.toContain("SYNTHETIC_CONFIG_SENTINEL")
      expect(bundle.config && [2, 3].includes(bundle.config.version)).toBe(true)
      if (!bundle.config || bundle.config.version === 1) throw new Error("Actual producer Markdown review missing")
      expect(bundle.config.markdown.some((entry) => entry.value.body.includes("Preserve command café 日本語 😀"))).toBe(
        true,
      )
      expect(bundle.config.markdown.some((entry) => entry.value.body.includes("Preserve mode café 日本語 😀"))).toBe(
        true,
      )
      expect(
        bundle.config.markdown.some((entry) =>
          entry.value.excluded.some((field) => field.field === "body" && field.reason === "substitution"),
        ),
      ).toBe(true)
      expect(JSON.stringify(bundle.config)).not.toContain("SYNTHETIC_MARKDOWN_SENTINEL")
      expect(JSON.stringify(bundle.config)).not.toContain("SYNTHETIC_EXPANDED_MARKDOWN_SENTINEL")
      expect(JSON.stringify(bundle.config)).not.toContain("SYNTHETIC_MARKDOWN_LITERAL_SENTINEL")
      expect(
        bundle.config.markdown.some((entry) =>
          entry.value.excluded.some((field) => field.reason === "recognized-credential"),
        ),
      ).toBe(true)
      for (const [index, document] of documents.entries()) {
        expect(await readFile(document.file, "utf8")).toBe(published[index])
        expect(configuredGraph?.documents[index].digest).toBe(
          createHash("sha256").update(published[index]).digest("hex"),
        )
      }
      expect(
        bundle.stores?.some((store) => store.kind === "absent" && store.source.toLowerCase() === missing.toLowerCase()),
      ).toBe(true)
      expect(await Bun.file(missing).exists()).toBe(false)
      const exported = bundle.sql.find((table) => table.table === "session")
      expect(exported).toBeDefined()
      expect(exported?.rows.some((row) => row[exported.columns.indexOf("id")] === created.id)).toBe(true)
      expect(bundle.artifacts?.worktrees).toHaveLength(1)
      const worktree = bundle.artifacts?.worktrees[0]
      expect(worktree?.workspace).toBe(managed)
      expect(
        Buffer.from(worktree?.files.find((file) => file.path === "actual.txt")?.bytes ?? "", "base64").toString(),
      ).toBe(dirty)
      expect(worktree?.files.some((file) => file.path === "untracked.txt")).toBe(true)
      expect(
        bundle.artifacts?.repositories.some((repository) => repository.files.some((file) => file.path === "HEAD")),
      ).toBe(true)
      expect(await readFile(path.join(managed, "actual.txt"), "utf8")).toBe(dirty)
      expect(await git("rev-parse", "HEAD")).toBe(head)
      expect(bundle.host).toEqual(host)
      const capsules = bundle.disposition.files.filter((entry) => entry.disposition.kind === "host-semantic")
      expect(capsules).toHaveLength(1)
      const native = capsules[0]
      if (native.disposition.kind !== "host-semantic") throw new Error("Actual host correspondence missing")
      const stamp = await lstat(native.path, { bigint: true })
      expect(native.disposition.source).toBe(native.path)
      expect(native.disposition.identity).toEqual({ dev: stamp.dev.toString(), ino: stamp.ino.toString() })
      expect(native.disposition.bytes).toBe(Number(stamp.size))
      expect(native.disposition.sourceDigest).toBe(
        createHash("sha256")
          .update(await readFile(native.path))
          .digest("hex"),
      )
      expect(native.disposition).toMatchObject({
        rawBytesPreserved: false,
        envelopeAuthority: "excluded",
        historicalIntent: "inert",
        activation: "held",
      })
      expect(
        bundle.disposition.roots.some((root) => root.kind === "json" && !root.directory && root.path === native.path),
      ).toBe(true)
      validateHost(native.disposition, bundle.host)
      const altered = structuredClone(bundle)
      altered.host!.hosts[0].revision++
      expect(payload.safeParse(altered).success).toBe(false)
      expect(bundle.host!.hosts[0].contexts[0].root?.path).toBe(absent)
      expect(await Bun.file(absent).exists()).toBe(false)
      expect(() => owner.addSession("late-after-capture", null)).toThrow("retired")
      expect(JSON.parse(await readFile(state, "utf8"))).toEqual(models)
      await assert.rejects(unseal(await Bun.file(output).text(), password + "wrong"))
      const database = new Database(file, { readonly: true })
      try {
        const rows = database
          .query<{ id: string; time_completed: number }, []>("SELECT id,time_completed FROM migration")
          .all()
        expect(
          correspondence.journal?.rows.every((entry) =>
            rows.some((row) => row.id === entry.id && row.time_completed === entry.time_completed),
          ),
        ).toBe(true)
        expect(database.query("SELECT title FROM session WHERE id=?").get(created.id)).toEqual({
          title: "export-producer-durable-session",
        })
      } finally {
        database.close()
      }
      for (const file of ["source-handoff", "source-producer-observed", "source-export-result"]) {
        const text = await Bun.file(`${session.ticket.control}.${file}`).text()
        expect(text).not.toContain(password)
      }
      expect(Buffer.concat(stdout).toString() + Buffer.concat(stderr).toString()).not.toContain(password)
      expect(JSON.stringify(result)).not.toContain(password)
      const restored = path.join(root, "restore-fixture")
      await mkdir(restored)
      const child = Bun.spawn(
        [
          process.execPath,
          "run",
          "--conditions=browser",
          path.join(import.meta.dir, "fixtures/source-export-restore.ts"),
          output,
          restored,
        ],
        {
          env: {
            ...env,
            RAYA_TEST_DIRECTORY_HELPER: process.env.RAYA_TEST_DIRECTORY_HELPER,
            HOME: path.join(restored, "home"),
            USERPROFILE: path.join(restored, "home"),
            KILO_TEST_HOME: path.join(restored, "home"),
            LOCALAPPDATA: path.join(restored, "local"),
            XDG_DATA_HOME: path.join(restored, "data"),
            XDG_CONFIG_HOME: path.join(restored, "config"),
            XDG_CACHE_HOME: path.join(restored, "cache"),
            XDG_STATE_HOME: path.join(restored, "state"),
            RAYA_DB: path.join(restored, "unused.db"),
            KILO_DB: path.join(restored, "unused.db"),
          },
          windowsHide: true,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      await child.stdin.write(JSON.stringify({ password, secondHop: true }))
      await child.stdin.end()
      const timer = setTimeout(() => child.kill("SIGKILL"), 60000)
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        await Bun.write(path.join(restored, "stdout.log"), stdout)
        await Bun.write(path.join(restored, "stderr.log"), stderr)
        expect(code, stderr).toBe(0)
        const receipt = await Bun.file(path.join(restored, "source-export-restore-receipt.json")).text()
        expect(JSON.parse(receipt).passed).toBe(true)
        expect(JSON.parse(receipt)).toMatchObject({
          secondExportAttempted: true,
          secondHop: {
            passed: true,
            sourceCode: 0,
            familyZero: true,
            configHistorical: true,
            configActivated: false,
            compiled: false,
          },
        })
        expect(receipt + stdout + stderr).not.toContain(password)
        expect(() => process.kill(child.pid, 0)).toThrow()
      } finally {
        clearTimeout(timer)
      }
      for (const pid of [session.ticket.header.pid, session.ticket.header.helper, result.result.receiver.pid])
        expect(() => process.kill(pid, 0)).toThrow()
      await Bun.write(
        path.join(root, "receipt.json"),
        JSON.stringify({
          passed: true,
          result,
          integrated,
          gitMetadata,
          voice,
          operational,
          derived,
          quarantine,
          ...(secret === undefined ? {} : { passwordFile: secret }),
          composerClaims: composerClaims.length,
          forced: false,
          portableCaptureAuthorized: false,
        }),
      )
    } catch (err) {
      errors.push(err)
    } finally {
      await Bun.write(path.join(root, "stdout.log"), Buffer.concat(stdout))
      await Bun.write(path.join(root, "stderr.log"), Buffer.concat(stderr))
      if (session.child.exitCode === null) {
        await session.abort().catch((err) => errors.push(err))
        errors.push(new Error("Forced source fixture cleanup"))
      }
      if (errors.length)
        await Bun.write(
          path.join(root, "failure.json"),
          JSON.stringify({
            errors: errors.map((err) => {
              const describe = (value: unknown): unknown =>
                value instanceof AggregateError
                  ? { message: value.message, errors: value.errors.map(describe) }
                  : value instanceof Error
                    ? { message: value.message, cause: value.cause === undefined ? undefined : describe(value.cause) }
                    : String(value)
              return JSON.stringify(describe(err)).replaceAll(password, "<redacted>")
            }),
            ticket: session.ticket,
            portableCaptureAuthorized: false,
          }),
        )
    }
    if (errors.length) throw new AggregateError(errors, `Retained actual producer failure: ${root}`)
  },
  120000,
)
