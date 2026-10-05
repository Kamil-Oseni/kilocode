import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import {
  attach,
  collect,
  discover,
  artifacts,
  materialize,
  type Artifacts,
} from "../../src/kilocode/migration/profile-artifacts"
import { withWorking } from "../../src/kilocode/migration/profile-image"
import { select } from "../../src/kilocode/migration/profile-selection"
import { identity } from "../../src/kilocode/migration/profile-workspaces"

for (const format of ["sha1", "sha256"] as const)
  test.skipIf(process.platform !== "win32")(
    `locked ${format} Git artifacts retain real tree/index/worktree bytes without activating source hooks`,
    async () => {
      const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-git-artifacts-")))
      const primary = path.join(root, "primary")
      const data = path.join(root, "data")
      const storage = path.join(data, "storage")
      const workspace = path.join(data, "worktree", "project", "one")
      const repair = path.join(root, "repair")
      await Promise.all([
        mkdir(primary),
        mkdir(storage, { recursive: true }),
        mkdir(path.dirname(workspace), { recursive: true }),
      ])
      const env = {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: path.join(root, "absent-config"),
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@invalid",
        GIT_TERMINAL_PROMPT: "0",
      }
      const git = async (cwd: string, ...args: string[]) => {
        const child = Bun.spawn(["git", ...args], {
          cwd,
          env,
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
      await git(primary, "init", `--object-format=${format}`)
      await writeFile(path.join(primary, "actual.txt"), "committed café 日本語 😀\n")
      await git(primary, "add", "actual.txt")
      await git(primary, "commit", "-m", "fixture")
      await git(primary, "worktree", "add", "-b", "fixture-worktree", workspace)
      await git(primary, "worktree", "add", "-b", "fixture-repair", repair)
      await writeFile(path.join(repair, "actual.txt"), "historical repair café 日本語 😀\n")
      const status = await git(repair, "status", "--porcelain")
      await writeFile(path.join(workspace, "actual.txt"), "uncommitted native worktree bytes\n")
      await writeFile(path.join(workspace, "new.txt"), "staged native index bytes\n")
      await mkdir(path.join(workspace, "empty-directory"))
      await git(workspace, "add", "new.txt")
      const before = await git(workspace, "status", "--porcelain")
      const hash = createHash("sha1").update(primary).digest("hex")
      const snapshot = path.join(data, "snapshot", "project", hash)
      await mkdir(snapshot, { recursive: true })
      await git(primary, "init", "--bare", `--object-format=${format}`, snapshot)
      await copyFile(path.join(primary, ".git", "index"), path.join(snapshot, "index"))
      await writeFile(
        path.join(snapshot, "objects", "info", "alternates"),
        path.join(primary, ".git", "objects") + "\n",
      )
      const tree = await git(primary, "--git-dir", snapshot, "--work-tree", primary, "write-tree")
      expect(tree.length).toBe(format === "sha256" ? 64 : 40)
      await writeFile(path.join(primary, "actual.txt"), "dirty primary café 日本語 😀\n")
      await writeFile(path.join(primary, "extra.txt"), "untracked primary bytes\n")
      await writeFile(path.join(primary, ".env"), "PRIVATE_TOKEN=fixture-only-secret\n")
      await writeFile(path.join(primary, "kilo.json"), '{"apiKey":"fixture-only-secret"}')
      await mkdir(path.join(primary, "empty-primary"))
      const hook = "#!/bin/sh\necho forbidden-hook > activated.txt\n"
      await writeFile(path.join(primary, ".git", "hooks", "post-checkout"), hook)
      await git(primary, "config", "remote.private.url", "https://fixture-user:fixture-password@invalid/repository")
      await git(primary, "config", "credential.helper", "fixture-credential-command")
      const database = path.join(data, "raya.db")
      const db = new Database(database)
      db.exec("CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES('actual')")
      db.close()
      const policy = { version: 1 as const, directories: [data, primary, repair], files: [] }
      const selected = await select({ database, storage }, policy)
      const roots = await discover({ data, workspaces: [primary, workspace, repair] })
      expect(roots.some((root) => root.path === path.join(primary, ".git"))).toBe(true)
      const executable = await realpath(
        path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe"),
      )
      const digest = createHash("sha256")
        .update(await readFile(executable))
        .digest("hex")
      const selection = {
        ...selected,
        roots: [
          ...selected.roots,
          ...roots.filter((root) => !root.path.startsWith(data + path.sep)),
          { kind: "json" as const, path: repair },
        ],
      }
      const stage = path.join(root, "inactive", ".pending")
      const destination = path.join(root, "inactive", "data", "kilo")
      const mapped = path.join(destination, "worktree", "project", "one")
      const recovered = path.join(
        destination,
        "worktree",
        "historical",
        createHash("sha256").update(identity(repair)).digest("hex"),
      )
      const primaryMapping = path.join(root, "restored-primary")
      await mkdir(primaryMapping)
      await mkdir(stage, { recursive: true })
      const mapping = new Map([
        [primary, primaryMapping],
        [workspace.replaceAll("\\", "/"), mapped],
        [repair, recovered],
      ])
      let saved: Artifacts | undefined
      await withImage(
        { roots: selection.roots, policy, helper: { executable, digest }, registry: path.join(root, "registry") },
        async (image) => {
          await withWorking(image, selection, async (working) => {
            const value = await collect(working, { data, workspaces: [primary, workspace, repair] })
            saved = value
            expect(value.worktrees).toHaveLength(2)
            expect(value.snapshots).toHaveLength(1)
            const item = value.repositories.find((item) => item.working)!
            expect(item.working!.excluded).toEqual([
              { path: ".env", reason: "credentials" },
              { path: "kilo.json", reason: "configuration" },
            ])
            expect(JSON.stringify(value)).not.toContain("fixture-only-secret")
            const credential = structuredClone(value)
            credential.repositories.find((item) => item.working)!.working!.excluded[0].reason = "configuration"
            expect(artifacts.safeParse(credential).success).toBe(false)
            const altered = structuredClone(value)
            altered.repositories.find((item) => item.working)!.working!.files[0].digest = "0".repeat(64)
            expect(artifacts.safeParse(altered).success).toBe(false)
            await assert.rejects(
              collect(working, { data, workspaces: [item.workspace!] }, { bytes: 1, nodes: 20_000 }),
              /exceeds bound/,
            )
            for (const repository of value.repositories) {
              const configuration = repository.files.find((file) => file.path === "config")
              if (!configuration) continue
              const text = Buffer.from(configuration.bytes, "base64").toString("utf8")
              expect(text).not.toContain("fixture-password")
              expect(text).not.toContain("credential")
            }
            const corrupt = structuredClone(value)
            corrupt.repositories[0].files[0].digest = "0".repeat(64)
            expect(artifacts.safeParse(corrupt).success).toBe(false)
            const escaped = structuredClone(value)
            escaped.repositories[0].directories.push("../outside")
            expect(artifacts.safeParse(escaped).success).toBe(false)
            for (const path of ["NUL", "objects/CON.txt", "refs/heads/trailing.", "refs/heads/trailing "]) {
              const invalid = structuredClone(value)
              invalid.repositories[0].directories.push(path)
              expect(artifacts.safeParse(invalid).success).toBe(false)
            }
            await assert.rejects(
              materialize(
                value,
                path.join(root, "wrong"),
                destination,
                new Map([
                  [primary, primary],
                  [workspace, primary],
                ]),
              ),
              /inactive profile/,
            )
            await materialize(value, stage, destination, mapping, [primary])
          })
        },
      )
      await withImage(
        { roots: selected.roots, policy, helper: { executable, digest }, registry: path.join(root, "registry") },
        (image) =>
          withWorking(image, selected, (working) =>
            assert.rejects(collect(working, { data, workspaces: [primary, workspace] }), /outside the locked/),
          ),
      )
      await mkdir(path.dirname(destination), { recursive: true })
      await rename(stage, destination)
      await attach(saved!, destination, mapping, [primary])
      const list = await git(primaryMapping, "worktree", "list", "--porcelain")
      expect(list).toContain(primaryMapping.replaceAll("\\", "/"))
      expect(list).toContain(mapped.replaceAll("\\", "/"))
      expect(list).toContain(recovered.replaceAll("\\", "/"))
      const pointer = await readFile(path.join(primaryMapping, ".git", "HEAD"), "utf8")
      await assert.rejects(attach(saved!, destination, mapping, [primary]), /fresh empty/)
      expect(await readFile(path.join(primaryMapping, ".git", "HEAD"), "utf8")).toBe(pointer)
      expect(await git(mapped, "status", "--porcelain")).toBe(before)
      expect(await git(recovered, "status", "--porcelain")).toBe(status)
      expect(await readFile(path.join(recovered, "actual.txt"), "utf8")).toBe("historical repair café 日本語 😀\n")
      expect(await readFile(path.join(mapped, "actual.txt"), "utf8")).toBe("uncommitted native worktree bytes\n")
      expect((await stat(path.join(mapped, "empty-directory"))).isDirectory()).toBe(true)
      const restored = path.join(
        destination,
        "snapshot",
        "project",
        createHash("sha1").update(primaryMapping).digest("hex"),
      )
      expect(await git(primary, "--git-dir", restored, "--work-tree", primary, "write-tree")).toBe(tree)
      expect(await git(primary, "--git-dir", restored, "cat-file", "-p", tree)).toContain("actual.txt")
      const id = createHash("sha256")
        .update(
          process.platform === "win32"
            ? path.join(primary, ".git").replaceAll("\\", "/").toLowerCase()
            : path.join(primary, ".git"),
        )
        .digest("hex")
      const evidence = path.join(destination, "git-artifacts", "primary-evidence", id)
      expect(await readFile(path.join(evidence, "tree", "actual.txt"), "utf8")).toBe("dirty primary café 日本語 😀\n")
      expect(await readFile(path.join(evidence, "tree", "extra.txt"), "utf8")).toBe("untracked primary bytes\n")
      expect((await stat(path.join(evidence, "tree", "empty-primary"))).isDirectory()).toBe(true)
      await assert.rejects(readFile(path.join(evidence, "tree", ".env")), /ENOENT/)
      await assert.rejects(readFile(path.join(evidence, "tree", "kilo.json")), /ENOENT/)
      const manifest = JSON.parse(await readFile(path.join(evidence, "manifest.json"), "utf8"))
      expect(manifest.active).toBe(false)
      expect(manifest.excluded).toHaveLength(2)
      // Evidence is retained byte-for-byte, while the active repository has a generated safe config.
      const repositories = await discover({ data, workspaces: [primary, workspace] })
      expect(repositories.length).toBeGreaterThan(1)
      expect(
        await readFile(path.join(destination, "git-artifacts", "evidence", id, "hooks", "post-checkout"), "utf8"),
      ).toBe(hook)
      await assert.rejects(readFile(path.join(mapped, "activated.txt")), /ENOENT/)
      const receipt = path.join(root, "receipt.json")
      await writeFile(
        receipt,
        JSON.stringify(
          {
            format: "raya.git-artifact-test",
            version: 1,
            objectFormat: format,
            root,
            primary: primaryMapping,
            worktree: mapped,
            tree,
            status: before,
            registered: true,
            sourceHooksActivated: false,
            fullPortableCapture: false,
          },
          null,
          2,
        ),
      )
      console.info(`Git artifact receipt: ${receipt}`)
    },
    60000,
  )
