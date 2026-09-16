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
      "profile.cache.browser-uploads",
      "profile.credentials.auth",
      "profile.credentials.mcp",
      "profile.data.revert-note",
      "profile.data.tool-output",
      "profile.state.plugin-meta",
      "profile.state.sandbox-policy",
      "profile.state.sandbox-preference",
      "profile.storage.json",
      "profile.tmp.attachments",
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

  test("names the audited cache, repository, self-heal and diagnostics mutation owners", () => {
    const find = (id: string) => ProfileWriterManifest.manifest.writers.find((writer) => writer.id === id)

    expect(find("profile.cache.skills")?.sources).toEqual([
      "packages/core/src/skill/discovery.ts",
      "packages/opencode/src/skill/discovery.ts",
    ])
    expect(find("profile.cache.skills")?.sources).not.toContain("packages/opencode/src/kilocode/skill-remove.ts")

    expect(find("profile.bin.ripgrep")?.methods).toEqual([
      "ensure-directory",
      "write-archive",
      "create-temp",
      "extract-child",
      "copy-target",
      "chmod-target",
      "remove-archive",
      "remove-temp",
    ])
    expect(find("profile.bin.ripgrep")?.lifecycle).toContain("versioned target")

    expect(find("profile.data.repos")?.roots).toEqual(["repos", "state"])
    expect(find("profile.data.repos")?.sources).toEqual([
      "packages/core/src/git.ts",
      "packages/core/src/repository-cache.ts",
    ])
    expect(find("profile.data.repos")?.methods).toContain("reset-hard")

    expect(find("profile.data.self-heal")?.sources).toContain(
      "packages/opencode/src/kilocode/self-heal/worktree.ts",
    )
    expect(find("profile.data.self-heal")?.sources).toContain(
      "packages/opencode/src/kilocode/self-heal/verification.ts",
    )
    expect(find("profile.data.self-heal")?.methods).not.toContain("recover")
    expect(find("profile.data.self-heal")?.methods).not.toContain("remove")

    expect(find("profile.log.diagnostics")?.sources).toContain("packages/opencode/src/cli/cmd/tui.ts")
    expect(find("profile.log.diagnostics")?.sources).toContain("packages/opencode/src/cli/tui/worker.ts")
    expect(find("profile.log.diagnostics")?.methods).toContain("worker-heap-snapshot")

    expect(find("profile.state.model")?.sources).toEqual([
      "packages/kilo-jetbrains/backend/src/main/kotlin/ai/kilocode/backend/app/KiloBackendModelStateManager.kt",
      "packages/kilo-vscode/src/kilo-provider/model-state.ts",
      "packages/opencode/src/cli/cmd/run/variant.shared.ts",
      "packages/opencode/src/kilocode/config/model-state.ts",
      "packages/tui/src/context/local.tsx",
    ])
    expect(find("profile.state.model")?.sources).not.toContain("packages/opencode/src/kilocode/tool/task.ts")
    expect(find("profile.state.model")?.methods).toContain("replace-favorites")
    expect(find("profile.state.model")?.lifecycle).toContain("JetBrains mutex")

    expect(ProfileWriterManifest.manifest.gaps).toContain(
      "skill removal can unlink project or externally injected manifests outside profile roots",
    )
    expect(ProfileWriterManifest.manifest.gaps).toContain(
      "independently compiled Core service graphs can bypass an OpenCode-only writer replacement",
    )
  })
})
