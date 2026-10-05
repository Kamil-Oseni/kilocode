import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { withWorking, assertWorking, lookup, origin, type Working } from "../../src/kilocode/migration/profile-image"
import { select } from "../../src/kilocode/migration/profile-selection"
import { withOfflineCapture } from "../../src/kilocode/migration/capture-authority"
import { workspaceScopes } from "../../src/kilocode/migration/profile-workspace-scope"

test.skipIf(process.platform !== "win32")(
  "derived profile reads committed WAL and selected JSON only from the held image",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-derived-image-")))
    const data = path.join(root, "data")
    const live = path.join(root, "live")
    const storage = path.join(data, "storage")
    await Promise.all([mkdir(storage, { recursive: true }), mkdir(live)])
    const database = path.join(data, "raya.db")
    const db = new Database(path.join(live, "raya.db"))
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES('durable café 日本語 😀')",
    )
    db.exec(
      "CREATE TABLE project(id TEXT, worktree TEXT, sandboxes TEXT); CREATE TABLE session(directory TEXT, path TEXT); CREATE TABLE workspace(directory TEXT, extra TEXT)",
    )
    const workspace = path.join(data, "historical café 日本語 😀")
    db.query("INSERT INTO project VALUES(?,?,?)").run("global", "/", "[]")
    db.query("INSERT INTO session VALUES(?,?)").run(workspace, "relative/session")
    db.query("INSERT INTO workspace VALUES(?,?)").run(
      workspace,
      JSON.stringify({ directory: path.join(root, "opaque") }),
    )
    for (const suffix of ["", "-wal", "-shm"]) await copyFile(path.join(live, "raya.db") + suffix, database + suffix)
    db.close()
    const preference = path.join(data, "model.json")
    await writeFile(preference, '{"recent":["private-model"]}')
    const observed = await lstat(preference, { bigint: true })
    await writeFile(path.join(storage, "actual.json"), '{"draft":"café 日本語 😀"}')
    const policy = { version: 1 as const, directories: [data], files: [] }
    const selection = await select({ database, storage, preferences: { modelState: preference } }, policy)
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
    const missing = path.join(data, "historical-missing.db")
    const selected = {
      ...selection,
      roots: [
        ...selection.roots.filter((root) => root.kind === "sqlite"),
        { kind: "sqlite" as const, path: missing },
        ...selection.roots.filter((root) => root.kind === "json"),
        { kind: "json" as const, path: preference },
      ],
      globals: [roles],
    }
    const sums = await Promise.all(
      ["", "-wal", "-shm"].map(async (suffix) =>
        createHash("sha256")
          .update(await readFile(database + suffix))
          .digest("hex"),
      ),
    )
    const executable = await realpath(
      path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe"),
    )
    const digest = createHash("sha256")
      .update(await readFile(executable))
      .digest("hex")
    let token: Working | undefined
    let working: string | undefined
    await withImage(
      { roots: selected.roots, policy, helper: { executable, digest }, registry: path.join(root, "registry") },
      async (image) => {
        await withWorking(image, selected, async (proof) => {
          token = proof
          const value = assertWorking(proof)
          expect(await workspaceScopes(proof)).toEqual([workspace])
          expect(value.stores).toEqual([
            { original: database, staged: value.profile.database, present: true },
            { original: missing, present: false },
          ])
          expect(Object.isFrozen(value.stores)).toBe(true)
          expect(Object.isFrozen(value.stores[1])).toBe(true)
          expect(lookup(proof, storage)).toBe(value.profile.storage)
          expect(lookup(proof, database, "sqlite")).toBe(value.profile.database)
          expect(() => lookup(proof, missing, "sqlite")).toThrow("no present reader mapping")
          expect(() => lookup(proof, database)).toThrow("exact declared")
          expect(origin(proof, preference)).toEqual({
            dev: observed.dev.toString(),
            ino: observed.ino.toString(),
            bytes: Number(observed.size),
            digest: createHash("sha256").update('{"recent":["private-model"]}').digest("hex"),
          })
          expect(Object.isFrozen(origin(proof, preference))).toBe(true)
          expect(() => origin(proof, data)).toThrow("exact native source identity")
          expect(value.namespaces[0].original).toEqual(roles)
          expect(value.namespaces[0].staged.data).toBe(value.profile.data)
          expect(value.namespaces[0].staged.state).toBe(value.profile.storage)
          expect(Object.isFrozen(value.namespaces[0].staged)).toBe(true)
          working = path.dirname(value.profile.database)
          expect(value.profile.database).not.toBe(database)
          using recovered = new Database(value.profile.database, { readonly: true, strict: true })
          expect(recovered.query("SELECT value FROM evidence").get()).toEqual({ value: "durable café 日本語 😀" })
          expect(await readFile(path.join(value.profile.storage, "actual.json"), "utf8")).toBe(
            '{"draft":"café 日本語 😀"}',
          )
          expect(await readFile(value.profile.preferences.modelState!, "utf8")).toBe('{"recent":["private-model"]}')
          expect(() => assertWorking(JSON.parse(JSON.stringify(value)))).toThrow("unavailable")
          await assert.rejects(
            withOfflineCapture({}, proof, async () => undefined),
            /authority/,
          )
        })
        expect(() => assertWorking(token)).toThrow("expired")
        expect(() => lookup(token!, storage)).toThrow("expired")
        await assert.rejects(workspaceScopes(token!), /expired/)
        await assert.rejects(
          withWorking(
            image,
            { ...selected, globals: [{ ...roles, config: path.join(data, "undeclared") }] },
            async () => {
              throw new Error("Undeclared namespace reader must not run")
            },
          ),
          (err: unknown) =>
            err instanceof AggregateError &&
            err.errors.some((err) => err instanceof Error && /held image mapping/.test(err.message)),
        )
      },
    )
    expect(working).toBeDefined()
    await assert.rejects(readFile(path.join(working!, "raya.db")), /ENOENT/)
    expect(
      await Promise.all(
        ["", "-wal", "-shm"].map(async (suffix) =>
          createHash("sha256")
            .update(await readFile(database + suffix))
            .digest("hex"),
        ),
      ),
    ).toEqual(sums)
    await writeFile(path.join(data, "after-image.txt"), "source permissions restored")
    const failure = new Error("Actual derived reader failure")
    await assert.rejects(
      withImage(
        { roots: selected.roots, policy, helper: { executable, digest }, registry: path.join(root, "registry") },
        (image) =>
          withWorking(image, selected, async () => {
            throw failure
          }),
      ),
      (err: unknown) =>
        err instanceof AggregateError &&
        err.errors.some((err) => err instanceof AggregateError && err.errors.includes(failure)),
    )
    await writeFile(path.join(data, "after-failure.txt"), "failure rollback restored")
  },
)
