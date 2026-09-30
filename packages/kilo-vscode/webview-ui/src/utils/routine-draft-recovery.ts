type File = { id: string; name: string; mime: string; size: number }

/** A cached pending edit is settled only by matching authoritative content and revision. */
export function matches(
  cached: { body: string; files: File[]; base?: number; owner?: string; conversationID?: string },
  saved: { draft?: string; draftAttachments?: File[]; draftRevision?: number; owner?: string; conversationID?: string },
) {
  return (
    !!cached.owner &&
    !!cached.conversationID &&
    cached.owner === saved.owner &&
    cached.conversationID === saved.conversationID &&
    (saved.draftRevision ?? 0) >= (cached.base ?? 0) &&
    sameContent(cached, saved)
  )
}

export function sameContent(
  cached: { body: string; files: File[] },
  saved: { draft?: string; draftAttachments?: File[] },
) {
  return (
    cached.body === (saved.draft ?? "") && JSON.stringify(cached.files) === JSON.stringify(saved.draftAttachments ?? [])
  )
}
