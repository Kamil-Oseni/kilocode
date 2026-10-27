import type { LocalInferenceSnapshot } from "../../../src/shared/local-inference"

const stamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value)

export function read(value: unknown, sessionID: string, now: number): LocalInferenceSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const row = value as Record<string, unknown>
  if (row.version !== 1 || row.sessionID !== sessionID || !id(row.sessionID) || typeof row.epoch !== "string") return
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.epoch)) return
  if (!stamp(row.observedAt) || !stamp(now) || row.observedAt > now || now - row.observedAt > 15_000) return
  if (!Array.isArray(row.requests) || row.requests.length > 9) return
  const requests: LocalInferenceSnapshot["requests"] = []
  const seen = new Set<string>()
  for (const item of row.requests) {
    const parsed = entry(item, row.observedAt)
    if (!parsed || seen.has(parsed.messageID)) return
    seen.add(parsed.messageID)
    requests.push(parsed)
  }
  return { version: 1, sessionID, epoch: row.epoch, observedAt: row.observedAt, requests }
}

function entry(value: unknown, observedAt: number): LocalInferenceSnapshot["requests"][number] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const row = value as Record<string, unknown>
  if (!id(row.messageID) || !stamp(row.queued) || !stamp(row.active) || row.queued > 9 || row.active > 9) return
  if (row.since !== undefined && (!stamp(row.since) || row.since > observedAt)) return
  return {
    messageID: row.messageID,
    queued: row.queued,
    active: row.active,
    ...(typeof row.since === "number" ? { since: row.since } : {}),
  }
}

function request(value: unknown, sessionID: string, messageID: string, now: number) {
  return read(value, sessionID, now)?.requests.find((row) => row.messageID === messageID)
}

export function wait(value: unknown, sessionID: string, messageID: string, now: number) {
  const row = request(value, sessionID, messageID, now)
  return row && row.queued > 0 && row.active === 0 && row.since !== undefined ? row : undefined
}
