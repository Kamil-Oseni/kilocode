import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { inventory, withWorking, type Working } from "../../src/kilocode/migration/profile-image"
import {
  bindDisposition,
  collectDisposition,
  disposition,
  validateDisposition,
} from "../../src/kilocode/migration/profile-disposition"
import { select } from "../../src/kilocode/migration/profile-selection"

test.skipIf(process.platform !== "win32")(
  "held file accounting preserves exact bindings and refuses unknown trees",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-disposition-")))
    const data = path.join(root, "data")
    const storage = path.join(data, "storage")
    await mkdir(storage, { recursive: true })
    const database = path.join(data, "raya.db")
    const db = new Database(database)
    db.exec("CREATE TABLE evidence(value TEXT)")
    db.close()
    await mkdir(path.join(data, "plans"))
    const note = path.join(data, "plans", "actual.md")
    const text = "# Durable café 日本語 😀\n"
    await writeFile(note, text)
    await utimes(note, 946684800.375, 946684800.375)
    const content = (value = text) => ({
      version: 1 as const,
      plans: [
        {
          scope: "data" as const,
          root: data,
          name: "actual.md",
          markdown: { text: value, digest: createHash("sha256").update(value).digest("hex") },
        },
      ],
      reverts: [],
    })
    await writeFile(path.join(data, "auth.json"), '{"provider":{"apiKey":"synthetic-credential-never-export"}}')
    await writeFile(path.join(storage, "unknown.json"), '{"unknown":"café 日本語 😀"}')
    await mkdir(path.join(data, "empty"))
    const missing = path.join(root, "missing-role")
    const control = path.join(root, "control")
    await mkdir(control)
    const policy = { version: 1 as const, directories: [data], files: [missing] }
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
      homeKilocode: missing,
      homeConfigKilo: missing,
    }
    const selection = {
      ...selected,
      roots: [...selected.roots, { kind: "json" as const, path: missing }],
      globals: [roles],
    }
    const helper = path.join(root, "raya-process-host.exe")
    await copyFile(
      process.env.RAYA_TEST_DIRECTORY_HELPER ??
        path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe"),
      helper,
    )
    const digest = createHash("sha256")
      .update(await readFile(helper))
      .digest("hex")
    const retained: { token?: Working; claim?: ReturnType<typeof bindDisposition> } = {}
    await withImage(
      {
        roots: selection.roots,
        policy,
        helper: { executable: helper, digest },
        registry: path.join(control, "registry"),
        inventory: "legacy",
      },
      (image) =>
        withWorking(image, selection, async (token) => {
          retained.token = token
          const raw = inventory(token)
          expect(Object.isFrozen(raw)).toBe(true)
          expect(Object.isFrozen(raw.files[0])).toBe(true)
          expect(raw.files.every((file) => file.modified === undefined)).toBe(true)
          expect(raw.roots.find((item) => item.path === missing)?.absent).toBe(true)
          const claim = bindDisposition(token, note, content())
          retained.claim = claim
          const ledger = collectDisposition(token, [claim])
          expect(ledger.files.find((file) => file.path === note)?.disposition.kind).toBe("preserved")
          expect(ledger.files.find((file) => file.path === note)?.roles.length).toBeGreaterThan(1)
          expect(ledger.files.find((file) => file.path.endsWith("auth.json"))?.disposition).toEqual({
            kind: "credential-omission",
            reason: "known-auth-store",
          })
          expect(ledger.files.find((file) => file.path.endsWith("unknown.json"))?.disposition.kind).toBe("unclassified")
          expect(ledger.incomplete).toEqual(["unclassified-files", "native-directory-inventory-unavailable"])
          expect(ledger.completeProfileCoverage).toBe(false)
          expect(ledger.portableCaptureAuthorized).toBe(false)
          expect(JSON.stringify(ledger)).not.toContain("synthetic-credential-never-export")
          expect(ledger.roots.find((item) => item.path === missing)?.absent).toBe(true)
          expect(() => collectDisposition(token, [claim], "strict-full")).toThrow("incomplete")
          expect(() => collectDisposition(token, [claim, claim])).toThrow("Conflicting")
          expect(() => bindDisposition(token, note, content(text + "changed"))).toThrow("bytes differ")
          expect(() => bindDisposition(token, path.join(data, "undeclared.md"), content())).toThrow(
            "native file identity",
          )
          expect(() => bindDisposition(token, path.join(data, "auth.json"), content())).toThrow("cannot be preserved")
          expect(Object.isFrozen(ledger.files[0])).toBe(true)
          expect(() => validateDisposition(ledger, content())).not.toThrow()
          expect(() => validateDisposition(ledger, content(text + "changed"))).toThrow("preserved notes")
          expect(() => validateDisposition(ledger)).toThrow("preserved notes")
          const altered = structuredClone(ledger)
          altered.incomplete = []
          altered.fingerprint = createHash("sha256")
            .update(JSON.stringify({ roots: altered.roots, globals: altered.globals, files: altered.files }))
            .digest("hex")
          expect(disposition.safeParse(altered).success).toBe(false)
          expect(() => collectDisposition(token, [JSON.parse(JSON.stringify(claim))])).toThrow("binding is absent")
          expect(disposition.safeParse({ ...ledger, fingerprint: "0".repeat(64) }).success).toBe(false)
          expect(disposition.safeParse({ ...ledger, files: Array(16385).fill(ledger.files[0]) }).success).toBe(false)
          expect(ledger.files.some((file) => file.path.endsWith("empty"))).toBe(false)
          assert.equal(disposition.parse(JSON.parse(JSON.stringify(ledger))).scope, "selected-held-files")
        }),
    )
    expect(() => inventory(retained.token!)).toThrow("expired")
    expect(() => collectDisposition(retained.token!, [retained.claim!])).toThrow("expired")
    await withImage(
      {
        roots: selection.roots,
        policy,
        helper: { executable: helper, digest },
        registry: path.join(control, "registry"),
      },
      (image) =>
        withWorking(image, selection, async (token) => {
          const ledger = collectDisposition(token, [bindDisposition(token, note, content())])
          const native = inventory(token)
          expect(ledger.files.every((file) => file.modified !== undefined)).toBe(true)
          const origin = ledger.files.find((file) => file.path === note)
          expect(origin?.modified).toBe(native.files.find((file) => file.path === note)?.modified)
          if (!origin?.modified) throw new Error("Native timestamp ledger evidence missing")
          expect((BigInt(origin.modified) - 116444736000000000n) * 100n).toBe(
            (await lstat(note, { bigint: true })).mtimeNs,
          )
          expect(disposition.parse(JSON.parse(JSON.stringify(ledger))).files).toEqual(ledger.files)
          for (const modified of ["-1", "1.5", "18446744073709551616", "0".repeat(21)]) {
            const malformed = structuredClone(ledger)
            malformed.files[0].modified = modified
            malformed.fingerprint = createHash("sha256")
              .update(
                JSON.stringify({
                  roots: malformed.roots,
                  globals: malformed.globals,
                  files: malformed.files,
                  directories: malformed.directories,
                }),
              )
              .digest("hex")
            expect(disposition.safeParse(malformed).success).toBe(false)
          }
          expect(ledger.directoryCoverage).toBe("verified")
          expect(ledger.incomplete).toEqual(["unclassified-files"])
          expect(ledger.directories?.find((item) => item.path === path.join(data, "empty"))?.children).toEqual([])
          expect(ledger.directories?.some((item) => item.path === missing)).toBe(false)
          expect(() => collectDisposition(token, [], "strict-full")).toThrow("incomplete")
          expect(ledger.portableCaptureAuthorized).toBe(false)
          const altered = structuredClone(ledger)
          altered.directories = []
          altered.fingerprint = createHash("sha256")
            .update(
              JSON.stringify({ roots: altered.roots, globals: altered.globals, files: altered.files, directories: [] }),
            )
            .digest("hex")
          expect(disposition.safeParse(altered).success).toBe(false)
        }),
    )
    expect(await readFile(note, "utf8")).toBe(text)
  },
)
