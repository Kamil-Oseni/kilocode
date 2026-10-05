import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { collect, materialize } from "../../src/kilocode/migration/profile-artifacts"
import { payload, seal, snapshot, unseal } from "../../src/kilocode/migration/profile-bundle"
import { collectDisposition } from "../../src/kilocode/migration/profile-disposition"
import { withWorking, type Working } from "../../src/kilocode/migration/profile-image"
import { readHistorical } from "../../src/kilocode/migration/profile-restored-evidence"
import {
  bindRestoredGit,
  restoredGitGroups,
  restoredGitValues,
  validateRestoredGit,
  type RestoredGitClaim,
} from "../../src/kilocode/migration/profile-restored-git-correspondence"
import { restoredGit } from "../../src/kilocode/migration/profile-restored-git-schema"
import { select } from "../../src/kilocode/migration/profile-selection"
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
test.skipIf(process.platform !== "win32")(
  "real Git materialization binds held source evidence through two encrypted inactive hops",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-restored-git-")))
    const helper = path.join(root, "raya-process-host.exe")
    await copyFile(
      process.env.RAYA_GIT_FIXTURE_HELPER ??
        path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe"),
      helper,
    )
    const digest = sha(await readFile(helper))
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(root, "absent-config"),
      GIT_TERMINAL_PROMPT: "0",
    }
    const retained: { token?: Working; claim?: RestoredGitClaim } = {}
    for (const format of ["sha1", "sha256"] as const) {
      const source = path.join(root, format, "source"),
        workspace = path.join(root, format, "workspace"),
        tree = path.join(source, "worktree", "project", "branch")
      await mkdir(path.join(source, "storage"), { recursive: true })
      await mkdir(workspace)
      const run = async (...args: string[]) => {
        const child = Bun.spawn(["git", "-C", workspace, ...args], {
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
        return out
      }
      await run("init", `--object-format=${format}`)
      await run("config", "user.name", "Private Fixture")
      await run("config", "user.email", "fixture@example.invalid")
      await writeFile(path.join(workspace, "actual.txt"), "actual café 日本語 😀\n")
      await run("add", ".")
      await run("commit", "-m", "actual private tree")
      await mkdir(path.dirname(tree), { recursive: true })
      await run("worktree", "add", "-b", "fixture", tree)
      await writeFile(path.join(tree, "actual.txt"), "managed café 日本語 😀\n")
      await cp(
        path.join(workspace, ".git"),
        path.join(source, "snapshot", "project", createHash("sha1").update(workspace).digest("hex")),
        { recursive: true },
      )
      await run("repack", "-ad")
      const capture = async <T>(data: string, extras: string[], body: (token: Working) => Promise<T>) => {
        const storage = path.join(data, "storage")
        await mkdir(storage, { recursive: true })
        const database = path.join(data, "raya.db")
        const db = new Database(database)
        db.exec("CREATE TABLE IF NOT EXISTS evidence(value TEXT)")
        db.close()
        const policy = { version: 1 as const, directories: [data, ...extras].sort(), files: [] }
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
        return withImage(
          {
            roots: [...selected.roots, ...extras.map((file) => ({ kind: "json" as const, path: file }))],
            policy,
            helper: { executable: helper, digest },
            registry: path.join(root, "registry", crypto.randomUUID()),
          },
          (image) =>
            withWorking(
              image,
              {
                ...selected,
                roots: [...selected.roots, ...extras.map((file) => ({ kind: "json" as const, path: file }))],
                globals: [roles],
              },
              body,
            ),
        )
      }
      const original = await capture(source, [workspace], async (token) =>
        snapshot.parse({
          format: "raya.profile-data",
          version: 1,
          id: crypto.randomUUID(),
          createdAt: Date.now(),
          schema: "0".repeat(64),
          workspaces: [workspace, tree],
          sql: [],
          json: [],
          artifacts: await collect(token, { data: source, workspaces: [workspace, tree] }),
          review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
        }),
      )
      for (const hop of [1, 2]) {
        const data = path.join(root, format, "hop" + hop)
        await mkdir(data)
        const password = crypto.randomUUID() + crypto.randomUUID()
        const decoded = await unseal(await seal({ ...original, archives: [] }, password), password)
        expect(decoded.artifacts).toEqual(original.artifacts)
        const mapped = path.join(root, format, "mapped" + hop)
        await mkdir(mapped)
        await materialize(
          decoded.artifacts!,
          data,
          data,
          new Map([
            [workspace, mapped],
            [tree, path.join(data, "worktree", "project", "branch")],
          ]),
        )
        await writeFile(path.join(data, "restore-source.json"), JSON.stringify(decoded))
        await writeFile(path.join(data, "git-artifacts", "unknown.txt"), "unknown remains unknown")
        await capture(data, [], async (token) => {
          const reader = await readHistorical(token),
            input = { archives: [original] },
            claim = await bindRestoredGit(token, reader, input)
          retained.token = token
          retained.claim = claim
          const groups = restoredGitGroups(token, claim)
          const components = { restoredArtifacts: restoredGitValues(token, claim) }
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
            claim,
          )
          const middle = payload.parse({
            ...original,
            id: crypto.randomUUID(),
            disposition: ledger,
            restoredArtifacts: components.restoredArtifacts,
            archives: [original],
          })
          const previous = snapshot.parse(
            Object.fromEntries(Object.entries(middle).filter(([key]) => key !== "archives")),
          )
          const last = payload.parse({
            ...middle,
            id: crypto.randomUUID(),
            archives: [original, previous],
          })
          expect(last.archives.length).toBe(2)
          expect(payload.safeParse({ ...middle, archives: [] }).success).toBe(false)
          expect(payload.safeParse({ ...last, archives: [previous] }).success).toBe(false)
          const changedArchive = { ...original, createdAt: original.createdAt + 1 }
          expect(payload.safeParse({ ...middle, archives: [changedArchive] }).success).toBe(false)
          for (const change of [
            { archive: crypto.randomUUID() },
            { archiveDigest: "0".repeat(64) },
            { namespace: "a".repeat(64) },
            { archive: middle.id },
          ]) {
            const altered = structuredClone(middle)
            altered.restoredArtifacts = altered.restoredArtifacts!.map((entry) => ({ ...entry, ...change }))
            expect(payload.safeParse(altered).success).toBe(false)
          }
          const projection = structuredClone(middle)
          projection.restoredArtifacts = projection.restoredArtifacts!.map((entry) => ({
            ...entry,
            artifacts: {
              ...entry.artifacts,
              repositories: entry.artifacts.repositories.map((repo) => ({
                ...repo,
                objectFormat: repo.objectFormat === "sha1" ? ("sha256" as const) : ("sha1" as const),
              })),
            },
          }))
          expect(payload.safeParse(projection).success).toBe(false)
          expect(payload.safeParse({ ...middle, archives: [original, previous] }).success).toBe(false)
          expect(groups.length).toBeGreaterThan(30)
          expect(
            groups.some(
              (entry) =>
                entry.selector.route === "repository-evidence" && entry.selector.path === "hooks/pre-commit.sample",
            ),
          ).toBe(true)
          expect(
            groups.some((entry) => entry.selector.route === "primary-tree" && entry.selector.path === "actual.txt"),
          ).toBe(true)
          expect(groups.some((entry) => entry.selector.route === "worktree-commondir")).toBe(true)
          expect(groups.some((entry) => entry.selector.route === "worktree-gitdir")).toBe(true)
          expect(groups.some((entry) => entry.source.endsWith("unknown.txt"))).toBe(false)
          expect(
            groups.some(
              (entry) =>
                entry.source ===
                path.join(data, "git-artifacts", "repositories", original.artifacts!.repositories[0].id, "config"),
            ),
          ).toBe(true)
          expect(groups.filter((entry) => entry.selector.route === "repository-config").length).toBe(
            original.artifacts!.repositories.length,
          )
          for (const entry of groups) validateRestoredGit(entry, components)
          expect(() => restoredGitGroups(token, JSON.parse(JSON.stringify(claim)))).toThrow("another held image")
          const tampered = { ...groups[0], digest: "0".repeat(64) }
          expect(() => validateRestoredGit(tampered, components)).toThrow("writer bytes")
          const changed = structuredClone(original)
          changed.createdAt++
          await assert.rejects(bindRestoredGit(token, reader, { archives: [changed] }), /Historical component differs/)
          const altered = { ...groups[0], selector: { ...groups[0].selector, repository: "0".repeat(64) } }
          expect(() => validateRestoredGit(altered, components)).toThrow("selector")
          expect(Object.isFrozen(groups)).toBe(true)
          expect(Object.isFrozen(components.restoredArtifacts[0].artifacts.repositories)).toBe(true)
          for (const ticks of ["-1", "1.5", "not-ticks", "18446744073709551616"]) {
            const changed = { ...groups[0], modified: ticks }
            expect(() => restoredGit.safeParse(changed)).not.toThrow()
            expect(restoredGit.safeParse(changed).success).toBe(false)
          }
          const wrong = {
            ...groups.find((entry) => entry.relationship === "materialize-generated")!,
            relationship: "archived-bytes" as const,
          }
          expect(() => validateRestoredGit(wrong, components)).toThrow("writer bytes")
        })
        expect(() => restoredGitGroups(retained.token!, retained.claim!)).toThrow("expired")
        const config = path.join(
          data,
          "git-artifacts",
          "repositories",
          original.artifacts!.repositories[0].id,
          "config",
        )
        await writeFile(config, (await readFile(config, "utf8")) + "[custom]\n value = excluded\n")
        await capture(data, [], async (token) => {
          expect(() => restoredGitGroups(token, retained.claim!)).toThrow("another held image")
          const reader = await readHistorical(token)
          const proof = await bindRestoredGit(token, reader, { archives: [original] })
          expect(restoredGitGroups(token, proof).some((entry) => entry.source === config)).toBe(false)
        })
        expect(
          payload.parse(JSON.parse(await readFile(path.join(data, "restore-source.json"), "utf8"))).artifacts,
        ).toEqual(original.artifacts)
      }
    }
  },
  120000,
)
