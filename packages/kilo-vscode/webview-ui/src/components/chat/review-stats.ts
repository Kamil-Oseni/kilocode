// raya_change - chat review counts prefer session snapshots over workspace git stats

export type ReviewCounts = {
  files: number
  additions: number
  deletions: number
  sessionID?: string
}

type Diff = {
  file?: string
  additions?: number
  deletions?: number
}

export function fromDiffs(diffs: Diff[]): ReviewCounts | undefined {
  const files = new Map<string, { additions: number; deletions: number }>()
  for (const item of diffs) {
    const file = item.file ?? ""
    if (!file || files.has(file)) continue
    files.set(file, { additions: item.additions ?? 0, deletions: item.deletions ?? 0 })
  }
  if (!files.size) return undefined
  let additions = 0
  let deletions = 0
  for (const item of files.values()) {
    additions += item.additions
    deletions += item.deletions
  }
  return { files: files.size, additions, deletions }
}

export function fromSummary(
  summary?: { files?: number; additions?: number; deletions?: number; diffs?: Diff[] } | null,
): ReviewCounts | undefined {
  if (summary?.diffs?.length) return fromDiffs(summary.diffs)
  if (!summary?.files) return undefined
  return { files: summary.files, additions: summary.additions ?? 0, deletions: summary.deletions ?? 0 }
}

function pathOf(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function shellOf(value: unknown): string[] {
  if (typeof value !== "string") return []
  const hits = [
    ...value.matchAll(/-(?:Path|FilePath|LiteralPath)\s+["']([^"']+)["']/gi),
    ...value.matchAll(/(?:>{1,2})\s*["']?([^\s"'|]+?\.\w{1,8})/g),
    ...value.matchAll(
      /\b(?:Set-Content|Add-Content|Out-File|New-Item|tee)\b[\s\S]{0,160}?["']([^"']+\.\w{1,8})["']/gi,
    ),
  ]
  return hits.map((item) => item[1] ?? "").filter(Boolean)
}

function listed(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const rec = item as { filePath?: string; file?: string; relativePath?: string }
    return [rec.filePath, rec.file, rec.relativePath].filter((path): path is string => !!path)
  })
}

function written(part: {
  tool?: string
  state?: { input?: Record<string, unknown>; metadata?: Record<string, unknown> }
}): string[] {
  const tool = part.tool ?? ""
  const input = part.state?.input
  if (tool === "bash" || tool === "shell") return shellOf(input?.command ?? input?.cmd)
  if (tool !== "write" && tool !== "edit" && tool !== "apply_patch" && tool !== "multiedit") return []
  const meta = part.state?.metadata
  const fd = meta?.filediff
  const file = fd && typeof fd === "object" ? pathOf((fd as { file?: string }).file) : ""
  return [pathOf(input?.filePath), pathOf(input?.path), pathOf(meta?.filepath), file, ...listed(meta?.files)].filter(
    Boolean,
  )
}

function fileOf(part: {
  type?: string
  tool?: string
  state?: { input?: Record<string, unknown>; metadata?: Record<string, unknown> }
}): string[] {
  if (part.type !== "tool") return []
  return written(part)
}

export function fromParts(
  parts: Array<{
    type?: string
    tool?: string
    state?: { input?: Record<string, unknown>; metadata?: Record<string, unknown> }
  }>,
): ReviewCounts | undefined {
  const files = new Set(parts.flatMap(fileOf))
  if (!files.size) return undefined
  return { files: files.size, additions: 0, deletions: 0 }
}

export function fromMessages(rows: Array<{ summary?: { diffs?: unknown[] } | boolean }>): ReviewCounts | undefined {
  const diffs: Diff[] = []
  for (const row of rows) {
    if (typeof row.summary !== "object" || !row.summary || !Array.isArray(row.summary.diffs)) continue
    for (const item of row.summary.diffs) {
      if (!item || typeof item !== "object") continue
      const rec = item as Diff
      diffs.push(rec)
    }
  }
  return fromDiffs(diffs)
}

export function prefer(...items: Array<ReviewCounts | undefined>): ReviewCounts | undefined {
  const hit = items.filter((item): item is ReviewCounts => !!item && item.files > 0)
  if (hit.length) return hit.reduce((best, item) => (item.files > best.files ? item : best))
  return items.find((item) => item !== undefined)
}

export function collect(input: {
  sid?: string
  sessions: Record<string, { parentID?: string | null; summary?: { files?: number; additions?: number; deletions?: number; diffs?: Diff[] } | null }>
  messages: Array<{ summary?: { diffs?: unknown[] } | boolean }>
  parts?: Array<{
    type?: string
    tool?: string
    state?: { input?: Record<string, unknown>; metadata?: Record<string, unknown> }
  }>
  live?: ReviewCounts
  git?: ReviewCounts
}): ReviewCounts | undefined {
  const own = input.sid ? fromSummary(input.sessions[input.sid]?.summary) : undefined
  const kids = Object.values(input.sessions)
    .filter((item) => item.parentID === input.sid)
    .map((item) => fromSummary(item.summary))
  const live = input.live && (!input.live.sessionID || input.live.sessionID === input.sid) ? input.live : undefined
  return prefer(own, ...kids, fromMessages(input.messages), fromParts(input.parts ?? []), live, input.git)
}

export function gather(
  sid: string | undefined,
  sessions: Record<string, { parentID?: string | null; summary?: { files?: number; additions?: number; deletions?: number; diffs?: Diff[] } | null }>,
  visible: (id: string) => Array<{ id: string; summary?: { diffs?: unknown[] } | boolean }>,
  parts: (id: string) => Array<{
    type?: string
    tool?: string
    state?: { input?: Record<string, unknown>; metadata?: Record<string, unknown> }
  }>,
  live?: ReviewCounts,
  git?: ReviewCounts,
): ReviewCounts | undefined {
  const ids = sid ? [sid, ...Object.keys(sessions).filter((id) => sessions[id]?.parentID === sid)] : []
  const rows = ids.flatMap((id) => visible(id))
  return collect({
    sid,
    sessions,
    messages: rows,
    parts: rows.flatMap((row) => parts(row.id)),
    live,
    git,
  })
}

export function apply(
  message: { type: string; sessionID?: string; files: number; additions: number; deletions: number },
  current: string | undefined,
  setWorktree: (value: ReviewCounts) => void,
  setDiff: (value: ReviewCounts) => void,
): boolean {
  if (message.type === "worktreeStatsLoaded") {
    setWorktree({ files: message.files, additions: message.additions, deletions: message.deletions })
    return true
  }
  if (message.type !== "reviewStatsLoaded") return false
  if (message.sessionID && message.sessionID !== current) return true
  setDiff({ files: message.files, additions: message.additions, deletions: message.deletions, sessionID: message.sessionID })
  return true
}
