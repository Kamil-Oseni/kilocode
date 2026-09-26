export type Probe = {
  loadedVersion: string
  loadedCaptureSha256?: string
  active?: { version: string; digest: string }
  expected?: { version: string; digest: string; captureSha256?: string }
  desktop: { host?: string; input?: string }
  backend: () => string
  process: () => { pid: number; startedAt: number; port: number; generation: number } | null
  lease: () => {
    grantHash: string
    level: "observe" | "assisted" | "autonomous"
    state: "active" | "paused" | "revoked" | "expired"
    scopeCount: number | null
    expiresAt: number | null
  } | null
  journal: () => {
    state: "durable" | "absent" | "migrating_legacy" | "malformed" | "unavailable"
    summary: {
      epoch: string
      revision: number
      lastAckAt: number | null
      pendingNative: { confirmed: number; unknown: number }
    } | null
  }
  observe: () => Promise<{
    before: { windowID: string; location?: string; identity?: string }
    after: { windowID: string; location?: string; identity?: string }
    window: { windowID: string; location?: string }
    width: number
    height: number
    timing: { acquisitionMs: number; preparationMs: number; semanticsMs?: number; totalMs: number }
    semantics?: { status: string; count: number; truncated: boolean }
  }>
}

function stable(value: Awaited<ReturnType<Probe["observe"]>>) {
  return (
    !!value.before.identity &&
    value.before.identity === value.after.identity &&
    value.before.windowID === value.after.windowID &&
    value.before.windowID === value.window.windowID &&
    value.before.location === value.after.location &&
    value.before.location === value.window.location
  )
}

function expected(input: Probe) {
  if (!input.expected || !input.active || !input.loadedCaptureSha256) return true
  return (
    input.expected.version === input.loadedVersion &&
    input.expected.digest.toLowerCase() === input.active.digest.toLowerCase() &&
    (!input.expected.captureSha256 ||
      input.expected.captureSha256.toLowerCase() === input.loadedCaptureSha256.toLowerCase())
  )
}

function changed(input: Probe, process: NonNullable<ReturnType<Probe["process"]>>, lease: ReturnType<Probe["lease"]>) {
  const next = input.process()
  if (
    !next ||
    next.pid !== process.pid ||
    next.startedAt !== process.startedAt ||
    next.port !== process.port ||
    next.generation !== process.generation
  )
    return "The managed Raya backend changed during observation"
  if (JSON.stringify(input.lease()) !== JSON.stringify(lease)) return "The Computer Use lease changed during observation"
  return null
}

function ready(input: Probe, process: ReturnType<Probe["process"]>) {
  if (input.backend() !== "connected") return "The Raya backend is disconnected"
  if (!process) return "No managed Raya backend process is connected"
  return null
}

function journal(value: ReturnType<Probe["journal"]>) {
  if (value.state === "durable" && value.summary) return { status: "durable" as const, ...value.summary }
  return { status: value.state === "durable" ? ("unavailable" as const) : value.state }
}

function evidence(value: ReturnType<typeof journal>) {
  return value.status === "durable" ? ("durable_summary" as const) : ("not_inspected" as const)
}

// Only host-local, non-pixel evidence is returned. A benchmark task needs separate action receipts and a final-state scorer.
export async function inspectInstalledHost(input: Probe) {
  const process = input.process()
  const lease = input.lease()
  const receipt = journal(input.journal())
  const base = {
    format: "raya.installed-desktop-host-probe" as const,
    version: 3 as const,
    observedAt: new Date().toISOString(),
    loadedVersion: input.loadedVersion,
    loadedCaptureSha256: input.loadedCaptureSha256 ?? null,
    active: input.active ?? null,
    expected: input.expected ?? null,
    desktop: input.desktop,
    backendProcess: process,
    lease,
    journal: receipt,
    releaseGateEligible: false as const,
    actionReceipts: null,
    receiptEvidence: evidence(receipt),
    taskFinalState: null,
  }
  if (!/^\d+\.\d+\.\d+-snapshot\+[^/\\]+$/.test(input.loadedVersion))
    return { ...base, status: "unavailable" as const, reason: "The loaded Raya extension is not an installed snapshot" }
  if (!input.loadedCaptureSha256 || !/^[a-f0-9]{64}$/i.test(input.loadedCaptureSha256))
    return {
      ...base,
      status: "unavailable" as const,
      reason: "The loaded native capture binary could not be identified",
    }
  if (!input.active || input.active.version !== input.loadedVersion)
    return {
      ...base,
      status: "unavailable" as const,
      reason: "The loaded host does not match the active package vault snapshot",
    }
  if (!expected(input))
    return { ...base, status: "unavailable" as const, reason: "The loaded host is not the expected installed snapshot" }
  const connection = ready(input, process)
  if (connection) return { ...base, status: "unavailable" as const, reason: connection }
  if (!input.desktop.host || !input.desktop.input || input.desktop.host !== input.desktop.input)
    return {
      ...base,
      status: "unavailable" as const,
      reason: "The extension host is not on the interactive input desktop",
    }
  const before = changed(input, process!, lease)
  if (before) return { ...base, status: "unavailable" as const, reason: before }
  const started = performance.now()
  const result = await input.observe().then(
    (value) => ({ value }),
    () => ({ value: undefined }),
  )
  if (input.backend() !== "connected")
    return { ...base, status: "unavailable" as const, reason: "The Raya backend disconnected during observation" }
  const after = changed(input, process!, lease)
  if (after) return { ...base, status: "unavailable" as const, reason: after }
  if (!result.value)
    return { ...base, status: "unavailable" as const, reason: "No stable foreground observation was available" }
  const value = result.value
  if (!stable(value))
    return {
      ...base,
      status: "unavailable" as const,
      reason: "The foreground target changed or had no process identity",
    }
  return {
    ...base,
    status: "observed" as const,
    foreground: {
      windowID: value.window.windowID,
      identity: value.before.identity,
      width: value.width,
      height: value.height,
    },
    capture: { ...value.timing, hostElapsedMs: performance.now() - started, semantics: value.semantics ?? null },
    note: "This is a live host observation, not an autonomous action or task-completion benchmark.",
  }
}
