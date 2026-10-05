import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { collect } from "../../src/kilocode/migration/profile-artifacts"
import { withWorking, type Working } from "../../src/kilocode/migration/profile-image"
import { bindGit, gitGroups, validateGit, type GitClaim } from "../../src/kilocode/migration/profile-git-correspondence"
import { collectDisposition, validateDisposition, disposition } from "../../src/kilocode/migration/profile-disposition"
import { select } from "../../src/kilocode/migration/profile-selection"
import { identity } from "../../src/kilocode/migration/profile-workspaces"

test.skipIf(process.platform !== "win32")(
  "Git correspondence joins actual held readers and exact inactive bytes",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-git-correspondence-")))
    const data = path.join(root, "data"),
      storage = path.join(data, "storage"),
      workspace = path.join(root, "workspace")
    await mkdir(storage, { recursive: true })
    await mkdir(workspace)
    const database = path.join(data, "raya.db")
    const db = new Database(database)
    db.exec("CREATE TABLE evidence(value TEXT)")
    db.close()
    const env = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(root, "absent-git-config"),
      GIT_TERMINAL_PROMPT: "0",
    }
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
      expect(code, err).toBe(0)
      return out
    }
    await run("init")
    await run("config", "user.name", "Private Fixture")
    await run("config", "user.email", "fixture@example.invalid")
    await writeFile(path.join(workspace, "actual.txt"), "actual café 日本語 😀\n")
    await run("add", "actual.txt")
    await run("commit", "-m", "private baseline")
    const tree = path.join(data, "worktree", "project", "branch")
    await mkdir(path.dirname(tree), { recursive: true })
    await run("worktree", "add", "-b", "fixture-branch", tree)
    await writeFile(path.join(tree, "actual.txt"), "managed café 日本語 😀\n")
    const hook = path.join(workspace, ".git", "hooks", "private.sample")
    await writeFile(hook, "# inert private café 日本語 😀\n")
    const unknown = path.join(data, "unknown.json")
    await writeFile(unknown, '{"unclassified":"café 日本語 😀"}')
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
    const retained: { token?: Working; claim?: GitClaim } = {}
    const capture = async (body: (token: Working) => Promise<void>) =>
      withImage(
        {
          roots: selection.roots,
          policy,
          helper: { executable: helper, digest },
          registry: path.join(root, "control", "registry"),
        },
        (image) => withWorking(image, selection, body),
      )
    await capture(async (token) => {
      const value = await collect(token, { data, workspaces: [workspace, tree] })
      const content = { artifacts: value }
      const claim = await bindGit(token, content)
      retained.token = token
      retained.claim = claim
      const groups = gitGroups(token, claim)
      const memory = await bindGit(token, { ...content, secondary: { namespaces: [{ id: "a".repeat(64) }] } })
      expect(gitGroups(token, memory)).toEqual(groups)
      expect(Object.isFrozen(groups)).toBe(true)
      expect(groups.length).toBeGreaterThan(10)
      expect(groups.some((entry) => entry.source === hook && entry.activation === "inert")).toBe(true)
      expect(
        groups.some((entry) => entry.selector.kind === "primary-working" && entry.selector.path === "actual.txt"),
      ).toBe(true)
      expect(groups.some((entry) => entry.selector.kind === "worktree" && entry.selector.path === "actual.txt")).toBe(
        true,
      )
      expect(groups.some((entry) => entry.source === path.join(workspace, ".git", "config"))).toBe(false)
      expect(groups.some((entry) => entry.source === path.join(tree, ".git"))).toBe(false)
      expect(groups.some((entry) => entry.source === unknown)).toBe(false)
      for (const entry of groups) expect(() => validateGit(entry, content)).not.toThrow()
      const changed = structuredClone(value)
      changed.repositories[0].files[0].bytes = Buffer.from("changed").toString("base64")
      changed.repositories[0].files[0].digest = createHash("sha256").update("changed").digest("hex")
      expect(() => validateGit(groups[0], { artifacts: changed })).toThrow("component differs")
      await assert.rejects(bindGit(token, { artifacts: changed }), /actual held artifact reader/)
      const altered = structuredClone(groups[0])
      altered.digest = "0".repeat(64)
      expect(() => validateGit(altered, content)).toThrow("decoded bytes")
      const fake = structuredClone(value)
      const text = '{"unclassified":"café 日本語 😀"}'
      fake.repositories.push({
        id: createHash("sha256").update(identity(data)).digest("hex"),
        source: data,
        files: [
          {
            path: "unknown.json",
            bytes: Buffer.from(text).toString("base64"),
            digest: createHash("sha256").update(text).digest("hex"),
            mode: 0o600,
          },
        ],
        directories: [],
        alternates: [],
        objectFormat: "sha1",
      })
      await assert.rejects(bindGit(token, { artifacts: fake }), /actual held artifact reader/)
      expect(() => gitGroups(token, JSON.parse(JSON.stringify(claim)))).toThrow("binding is absent")
      const ledger = collectDisposition(token, [], "selected", undefined, undefined, claim)
      expect(ledger.files.find((entry) => entry.path === hook)?.disposition.kind).toBe("git-bytes")
      expect(() => validateDisposition(ledger, undefined, undefined, undefined, content)).not.toThrow()
      expect(() => validateDisposition(ledger, undefined, undefined, undefined, { artifacts: changed })).toThrow(
        "component differs",
      )
      const forged = structuredClone(ledger)
      const entry = forged.files.find((entry) => entry.disposition.kind === "git-bytes")!
      if (entry.disposition.kind !== "git-bytes") throw new Error("Actual Git ledger missing")
      entry.disposition.ino = "0"
      forged.fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            roots: forged.roots,
            globals: forged.globals,
            files: forged.files,
            directories: forged.directories,
          }),
        )
        .digest("hex")
      expect(disposition.safeParse(forged).success).toBe(false)
      expect(ledger.files.find((entry) => entry.path === unknown)?.disposition.kind).toBe("unclassified")
      expect(() => collectDisposition(token, [], "strict-full", undefined, undefined, claim)).toThrow("incomplete")
    })
    expect(() => gitGroups(retained.token!, retained.claim!)).toThrow("expired")
    await capture(async (token) => {
      expect(() => gitGroups(token, retained.claim!)).toThrow("another image")
    })
    expect(await readFile(hook, "utf8")).toBe("# inert private café 日本語 😀\n")
  },
  60000,
)
