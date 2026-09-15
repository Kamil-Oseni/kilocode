import { describe, expect, test } from "bun:test"
import path from "node:path"
import { ProfileWriterManifest } from "@/kilocode/migration/writer-manifest"
import { ProfileWriterRegistry } from "@/kilocode/migration/writer-registry"

const root = path.resolve(import.meta.dir, "../../../..")

describe("profile writer manifest", () => {
  test("stays fail closed while audited boundaries or integration are incomplete", () => {
    const manifest = ProfileWriterManifest.manifest
    expect(manifest.complete).toBe(false)
    expect(manifest.gaps.length).toBeGreaterThan(0)
    expect(manifest.writers.filter((writer) => writer.coverage === "integrated").map((writer) => writer.id)).toEqual([
      "profile.credentials.auth",
      "profile.credentials.mcp",
      "profile.storage.json",
    ])
    expect(manifest.writers.filter((writer) => writer.coverage !== "integrated").length).toBeGreaterThan(0)
    expect(() => ProfileWriterRegistry.fromManifest(manifest)).toThrow("not complete and integrated")
  })

  test("keeps deterministic unique writer and maintenance identities", () => {
    const manifest = ProfileWriterManifest.manifest
    const writers = manifest.writers.map((writer) => writer.id)
    const maintenance = manifest.maintenance.map((item) => item.id)
    expect(writers).toEqual(writers.toSorted())
    expect(new Set([...writers, ...maintenance]).size).toBe(writers.length + maintenance.length)
    expect(writers).not.toContain("profile.maintenance.uninstall")
    expect(manifest.maintenance.find((item) => item.id === "profile.maintenance.uninstall")?.mode).toBe(
      "exclusive-destructive",
    )
  })

  test("references tracked source boundaries and names every mutation surface", async () => {
    const entries = [...ProfileWriterManifest.manifest.writers, ...ProfileWriterManifest.manifest.maintenance]
    for (const entry of entries) {
      expect(entry.sources.length).toBeGreaterThan(0)
      expect(entry.methods.length).toBeGreaterThan(0)
      expect(entry.roots.length).toBeGreaterThan(0)
      expect(entry.lifecycle.length).toBeGreaterThan(0)
      for (const source of entry.sources) {
        expect(path.isAbsolute(source)).toBe(false)
        expect(source).not.toContain("..")
        expect(await Bun.file(path.join(root, source)).exists()).toBe(true)
      }
    }
  })

  test("includes initialization writes and keeps destructive uninstall outside admission", () => {
    const storage = ProfileWriterManifest.manifest.writers.find((writer) => writer.id === "profile.storage.json")
    expect(storage?.methods).toEqual(["initialize", "migrate", "create", "replace", "write", "update", "remove"])
    expect(storage?.lifecycle).toContain("marker")

    const mcp = ProfileWriterManifest.manifest.writers.find((writer) => writer.id === "profile.credentials.mcp")
    expect(mcp?.methods).toEqual([
      "set",
      "remove",
      "updateTokens",
      "updateClientInfo",
      "updateCodeVerifier",
      "clearCodeVerifier",
      "updateOAuthState",
      "clearOAuthState",
    ])

    const effect = ProfileWriterManifest.manifest.writers.find(
      (writer) => writer.id === "profile.sqlite.primary.effect",
    )
    const legacy = ProfileWriterManifest.manifest.writers.find(
      (writer) => writer.id === "profile.sqlite.primary.legacy",
    )
    expect(effect?.methods).toContain("close")
    expect(legacy?.methods).toContain("close")
    expect(ProfileWriterManifest.manifest.maintenance.map((item) => item.id)).toEqual([
      "profile.maintenance.legacy-storage-migration",
      "profile.maintenance.uninstall",
    ])
  })
})
