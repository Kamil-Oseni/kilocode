function version(value: unknown) {
  if (typeof value !== "string" || value.length > 200) return "unknown"
  return /^(\d{1,4}\.\d{1,4}\.\d{1,8})(?:[-+][A-Za-z0-9.+-]+)?$/.exec(value)?.[1] ?? "unknown"
}

function choice(value: unknown, allowed: string[]) {
  return typeof value === "string" && allowed.includes(value) ? value : "unknown"
}

/** Deliberately project approved fields; never serialize a context, error, configuration or environment object. */
export function summary(input: Record<string, unknown>) {
  const build = typeof input.extension === "string" && input.extension.length <= 200 ? input.extension : ""
  const release = version(build)
  const commit =
    release === "unknown" ? undefined : /-snapshot\+([a-f0-9]{7,40})(?:\.|$)/i.exec(build)?.[1]?.toLowerCase()
  return {
    format: "raya.diagnostics",
    version: 1,
    extension: { version: release, ...(commit ? { commit } : {}) },
    host: {
      version: version(input.editor),
      platform: choice(input.platform, ["win32", "darwin", "linux"]),
      architecture: choice(input.architecture, ["x64", "arm64", "arm", "ia32"]),
      remote: input.remote === true,
    },
    workspace: {
      trusted: input.trusted === true,
      folders:
        typeof input.folders === "number" && Number.isInteger(input.folders) && input.folders >= 0
          ? Math.min(input.folders, 100)
          : 0,
    },
    backend: { state: choice(input.state, ["connecting", "connected", "disconnected", "error"]) },
    telemetry: { editorEnabled: input.telemetry === true },
  }
}
