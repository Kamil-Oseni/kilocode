import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { collect, materialize, attach, projectGitConfig } from "../../src/kilocode/migration/profile-artifacts"
import { withWorking, type Working } from "../../src/kilocode/migration/profile-image"
import { select } from "../../src/kilocode/migration/profile-selection"
import { identity } from "../../src/kilocode/migration/profile-workspaces"
import { payload, seal, unseal } from "../../src/kilocode/migration/profile-bundle"
import {
  bindGitMetadata,
  gitMetadataGroups,
  validateGitMetadata,
  type GitMetadataClaim,
} from "../../src/kilocode/migration/profile-git-metadata-correspondence"

test("Git config provenance omits finite source authority and refuses custom directives", () => {
  const text =
    '[core]\n bare = false\n hooksPath = secret-path\n[user]\n name = private-name\n[remote "origin"]\n url = private-credential\n[custom]\n arbitrary = unknown\n'
  const result = projectGitConfig(text)
  expect(result.text).toBe("[core]\n\tbare = false\n")
  expect(result.supported).toBe(false)
  expect(result.ledger.some((line) => line.reason === "omitted-connection-or-execution")).toBe(true)
  expect(result.ledger.some((line) => line.reason === "omitted-personal-identity")).toBe(true)
  expect(JSON.stringify(result)).not.toContain("private-credential")
  expect(JSON.stringify(result)).not.toContain("private-name")
  expect(projectGitConfig('[core "custom"]\nbare = false\n').supported).toBe(false)
  const platform = projectGitConfig("[core]\n bare = false\n autocrlf = false\n longpaths = true\n")
  expect(platform.supported).toBe(true)
  expect(platform.text).toBe("[core]\n\tbare = false\n")
  expect(platform.ledger.filter((line) => line.reason === "omitted-source-platform-option")).toHaveLength(2)
  for (const value of ["autocrlf = true", "autocrlf = input", "longpaths = false", "longpaths = 1"])
    expect(projectGitConfig(`[core]\n${value}\n`).supported).toBe(false)
  expect(projectGitConfig('[core "custom"]\nautocrlf = false\nlongpaths = true\n').supported).toBe(false)
})

test.skipIf(process.platform !== "win32")(
  "finite Git metadata joins native image, encrypted artifact hops, and actual remapped backlinks",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-git-metadata-")))
    const data = path.join(root, "data"),
      storage = path.join(data, "storage"),
      workspace = path.join(root, "workspace")
    await mkdir(storage, { recursive: true })
    await mkdir(workspace)
    const env = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(root, "absent"),
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@invalid",
    }
    const run = async (cwd: string, ...args: string[]) => {
      const child = Bun.spawn(["git", "-c", "core.fsmonitor=false", ...args], {
        cwd,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      })
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      assert.equal(code, 0, err)
      return out.trim()
    }
    await run(workspace, "init")
    await writeFile(path.join(workspace, "actual.txt"), "actual café 日本語 😀\n")
    await run(workspace, "add", "actual.txt")
    await run(workspace, "commit", "-m", "fixture")
    await run(workspace, "config", "remote.origin.url", "https://fixture:secret@invalid/repository")
    await run(workspace, "config", "credential.helper", "never-activate-fixture")
    await run(workspace, "config", "core.autocrlf", "false")
    await run(workspace, "config", "core.longpaths", "true")
    const tree = path.join(data, "worktree", "project", "branch")
    await mkdir(path.dirname(tree), { recursive: true })
    await run(workspace, "worktree", "add", "-b", "fixture-branch", tree)
    await writeFile(path.join(tree, "actual.txt"), "dirty café 日本語 😀\n")
    const admin = path.resolve(tree, (await readFile(path.join(tree, ".git"), "utf8")).slice(8).trim())
    await writeFile(path.join(admin, "ORIG_HEAD"), (await run(tree, "rev-parse", "HEAD")) + "\n")
    const database = path.join(data, "raya.db")
    const db = new Database(database)
    db.exec("CREATE TABLE evidence(value TEXT)")
    db.close()
    const helper = path.join(root, "raya-process-host.exe")
    await copyFile(path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe"), helper)
    const digest = createHash("sha256")
      .update(await readFile(helper))
      .digest("hex")
    const policy = { version: 1 as const, directories: [data, workspace], files: [] }
    const selected = await select({ database, storage }, policy)
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
    const selection = {
      ...selected,
      roots: [...selected.roots, { kind: "json" as const, path: workspace }],
      globals: [roles],
    }
    const capture = async (body: (token: Working) => Promise<void>) =>
      withImage(
        {
          roots: selection.roots,
          inventory: "directories",
          policy,
          helper: { executable: helper, digest },
          registry: path.join(root, "registry"),
        },
        (image) => withWorking(image, selection, body),
      )
    const retained: { token?: Working; claim?: GitMetadataClaim } = {}
    await capture(async (token) => {
      const value = await collect(token, { data, workspaces: [workspace, tree] })
      const claim = await bindGitMetadata(token, { artifacts: value })
      retained.token = token
      retained.claim = claim
      const groups = gitMetadataGroups(token, claim)
      await assert.rejects(writeFile(path.join(workspace, ".git", "config"), "foreign writer"))
      expect(Object.isFrozen(groups)).toBe(true)
      expect(groups.filter((entry) => entry.selector.kind === "pointer")).toHaveLength(1)
      expect(groups.filter((entry) => entry.selector.kind === "admin")).toHaveLength(6)
      const config = groups.find((entry) => entry.selector.kind === "config")
      expect(config).toBeDefined()
      expect(config?.ledger.some((line) => line.reason === "omitted-connection-or-execution")).toBe(true)
      expect(config?.ledger.filter((line) => line.reason === "omitted-source-platform-option")).toHaveLength(2)
      if (!config) throw new Error("Actual config provenance is missing")
      const omitted = structuredClone(config)
      omitted.ledger[0].reason = "omitted-personal-identity"
      expect(() => validateGitMetadata(omitted, { artifacts: value })).toThrow("provenance differs")
      const legacy = structuredClone(value)
      for (const repo of legacy.repositories) for (const file of repo.files) delete file.projection
      expect(
        payload.safeParse({
          format: "raya.profile-data",
          version: 1,
          id: randomUUID(),
          createdAt: 1,
          schema: "0".repeat(64),
          workspaces: [workspace, tree],
          sql: [],
          json: [],
          artifacts: legacy,
          review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
        }).success,
      ).toBe(true)
      const oversized = structuredClone(value)
      const projected = oversized.repositories.flatMap((repo) => repo.files).find((file) => file.projection)
      if (!projected?.projection) throw new Error("Actual config projection is missing")
      projected.projection.sourceBytes = 20000
      projected.projection.ledger = Array.from({ length: 20000 }, (_, line) => ({
        line,
        reason: "formatting" as const,
      }))
      expect(
        payload.safeParse({
          format: "raya.profile-data",
          version: 1,
          id: randomUUID(),
          createdAt: 1,
          schema: "0".repeat(64),
          workspaces: [workspace, tree],
          sql: [],
          json: [],
          artifacts: oversized,
          review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
        }).success,
      ).toBe(false)
      expect(groups.every((entry) => entry.activation === "inert")).toBe(true)
      for (const entry of groups) expect(() => validateGitMetadata(entry, { artifacts: value })).not.toThrow()
      const foreign = structuredClone(groups[0])
      foreign.source = path.join(root, "foreign", "config")
      expect(() => validateGitMetadata(foreign, { artifacts: value })).toThrow("selector differs")
      const changed = structuredClone(value)
      changed.repositories[0].files[0].digest = "0".repeat(64)
      await assert.rejects(bindGitMetadata(token, { artifacts: changed }))
      expect(() => gitMetadataGroups(token, JSON.parse(JSON.stringify(claim)))).toThrow("binding is absent")
      const password = "private-in-memory-codec-fixture"
      const input = payload.parse({
        format: "raya.profile-data",
        version: 1,
        id: randomUUID(),
        createdAt: 1,
        schema: "0".repeat(64),
        workspaces: [workspace, tree],
        sql: [],
        json: [],
        artifacts: value,
        review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
      })
      const first = await unseal(await seal(input, password), password)
      const second = await unseal(await seal(first, password), password)
      expect(second.artifacts).toEqual(value)
      for (const entry of groups)
        expect(() => validateGitMetadata(entry, { artifacts: second.artifacts })).not.toThrow()
      const pending = path.join(root, "destination", "pending"),
        destination = path.join(root, "destination", "data"),
        primary = path.join(root, "fresh-primary")
      await mkdir(pending, { recursive: true })
      await mkdir(primary)
      const mappings = new Map([
        [identity(workspace), primary],
        [identity(tree), path.join(destination, "worktree", "project", "branch")],
      ])
      await materialize(second.artifacts!, pending, destination, mappings, [workspace])
      // Materialization is still unpublished; move its exact data container before attaching the fresh primary.
      const { rename } = await import("node:fs/promises")
      await rename(pending, destination)
      await attach(second.artifacts!, destination, mappings, [workspace])
      const mapped = path.join(destination, "worktree", "project", "branch")
      const pointer = (await readFile(path.join(mapped, ".git"), "utf8")).slice(8).trim()
      expect((await readFile(path.join(pointer, "gitdir"), "utf8")).trim()).toBe(
        path.join(mapped, ".git").replaceAll("\\", "/"),
      )
      expect(await run(mapped, "status", "--porcelain")).toContain("M actual.txt")
      const configuration = await readFile(path.join(primary, ".git", "config"), "utf8")
      expect(configuration).not.toContain("fixture:secret")
      expect(configuration).not.toContain("never-activate-fixture")
      expect(await readFile(path.join(mapped, "actual.txt"), "utf8")).toBe("dirty café 日本語 😀\n")
    })
    expect(() => gitMetadataGroups(retained.token!, retained.claim!)).toThrow("expired")
    await run(workspace, "config", "custom.unsupported", "private-custom-value")
    await capture(async (token) => {
      expect(() => gitMetadataGroups(token, retained.claim!)).toThrow("another image")
      const value = await collect(token, { data, workspaces: [workspace, tree] })
      const claim = await bindGitMetadata(token, { artifacts: value })
      expect(
        gitMetadataGroups(token, claim).some((entry) => entry.source === path.join(workspace, ".git", "config")),
      ).toBe(false)
      expect(
        value.repositories.some((repo) =>
          repo.files.some((file) => file.path === "config" && file.projection?.supported === false),
        ),
      ).toBe(true)
    })
  },
  60000,
)
