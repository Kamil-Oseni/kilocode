type File = { id: string; name: string; mime: string; size: number }

/** A cached pending edit is settled only by matching authoritative content and revision. */
export function matches(
  cached: { body: string; files: File[]; revision?: number },
  saved: { draft?: string; draftAttachments?: File[]; draftRevision?: number },
) {
  return (
    (saved.draftRevision ?? 0) >= (cached.revision ?? 0) &&
    cached.body === (saved.draft ?? "") &&
    JSON.stringify(cached.files) === JSON.stringify(saved.draftAttachments ?? [])
  )
}
