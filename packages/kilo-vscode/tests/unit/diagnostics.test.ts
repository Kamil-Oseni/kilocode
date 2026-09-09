import { expect, test } from "bun:test"
import { summary } from "../../src/services/diagnostics"

test("diagnostic summaries project known fields without paths, identities, credentials or arbitrary error text", () => {
  const result = summary({
    extension: "7.4.23-snapshot+852ef79c5e.synthetic-private-name.1788990151878",
    editor: "1.104.0-insider",
    platform: "win32",
    architecture: "x64",
    remote: true,
    trusted: true,
    folders: 2,
    state: "connected",
    telemetry: false,
    password: "synthetic-password",
    directory: "C:/synthetic-private-workspace",
    environment: { API_KEY: "synthetic-key" },
    get error() {
      throw new Error("Diagnostic collection must not inspect arbitrary error objects")
    },
  })
  expect(result).toEqual({
    format: "raya.diagnostics",
    version: 1,
    extension: { version: "7.4.23", commit: "852ef79c5e" },
    host: { version: "1.104.0", platform: "win32", architecture: "x64", remote: true },
    workspace: { trusted: true, folders: 2 },
    backend: { state: "connected" },
    telemetry: { editorEnabled: false },
  })
  expect(JSON.stringify(result)).not.toContain("synthetic")
})

test("unexpected values cannot turn approved diagnostic fields into free-text export channels", () => {
  const result = summary({
    extension: "C:/synthetic-private-name-snapshot+abcdef0.file",
    editor: "synthetic-error-with-secret",
    platform: "synthetic-hostname",
    architecture: { token: "synthetic-key" },
    remote: "synthetic-remote-host",
    trusted: "true",
    folders: Number.NaN,
    state: "synthetic-error-body",
    telemetry: "true",
  })
  expect(result.extension).toEqual({ version: "unknown" })
  expect(result.host).toEqual({ version: "unknown", platform: "unknown", architecture: "unknown", remote: false })
  expect(result.workspace).toEqual({ trusted: false, folders: 0 })
  expect(result.backend).toEqual({ state: "unknown" })
  expect(result.telemetry).toEqual({ editorEnabled: false })
  expect(JSON.stringify(result)).not.toContain("synthetic")
  expect(summary({ extension: "1.2.3+synthetic-identity", folders: 10_000 }).extension).toEqual({ version: "1.2.3" })
  expect(summary({ folders: 10_000 }).workspace.folders).toBe(100)
})
