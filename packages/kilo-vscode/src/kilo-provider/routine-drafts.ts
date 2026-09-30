export type RoutineDraftProof = {
  owner: string
  conversationID: string
  revision: number
  draft?: string | null
  attachments?: { id: string }[]
}

type Scope = {
  agentID: string
  owner: string
  conversationID: string
  revision: number
  current: () => boolean
  read: () => Promise<RoutineDraftProof | undefined>
  write: (draft: string | null, attachmentIDs: string[], revision: number) => Promise<RoutineDraftProof | undefined>
}

type Pane = Scope & {
  sequence: number
  confirmed: number
  cutoff?: number
  pending: Map<number, Promise<void>>
  failures: Set<number>
  closed: boolean
  flushing: boolean
  sending?: Promise<void>
}

type Edit = {
  paneID: string
  agentID: string
  owner: string
  conversationID: string
  expectedRevision: number
  sequence: number
  draft: string | null
}

type Snapshot = {
  cutoff: number
  draft: string | null
  attachmentIDs: string[]
}

function same(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function refused(message: string): never {
  throw new Error(message)
}

function valid(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.length <= 256
}

function number(value: unknown, floor: number) {
  return Number.isSafeInteger(value) && Number(value) >= floor
}

async function bounded<T>(task: Promise<T>, deadline: number): Promise<T> {
  const timeout = Math.max(0, deadline - Date.now())
  if (!timeout) refused("Draft confirmation timed out.")
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Draft confirmation timed out.")), timeout)
  })
  return Promise.race([task, limit]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function content(ack: RoutineDraftProof, snapshot: Snapshot) {
  return (
    ack.draft === snapshot.draft &&
    same(
      (ack.attachments ?? []).map((file) => file.id),
      snapshot.attachmentIDs,
    )
  )
}

function proof(pane: Pane, ack: RoutineDraftProof | undefined, revision: number, deadline: number) {
  if (
    !ack ||
    ack.owner !== pane.owner ||
    ack.conversationID !== pane.conversationID ||
    ack.revision !== revision ||
    pane.closed ||
    !pane.current() ||
    Date.now() >= deadline
  )
    refused("The saved conversation changed before confirmation.")
  return ack
}

export class RoutineDrafts {
  private readonly panes = new Map<string, Pane>()

  mount(id: string, scope: Scope) {
    if (!valid(id) || !valid(scope.agentID) || !valid(scope.owner) || !valid(scope.conversationID))
      refused("Reload the conversation before saving its draft.")
    if (!number(scope.revision, 0) || !scope.current() || this.panes.has(id))
      refused("This conversation changed. Reload it before saving its draft.")
    this.panes.set(id, {
      ...scope,
      sequence: 0,
      confirmed: 0,
      pending: new Map(),
      failures: new Set(),
      closed: false,
      flushing: false,
    })
  }

  unmount(id: string, agentID: string) {
    const pane = this.panes.get(id)
    if (!pane || pane.agentID !== agentID) return
    pane.closed = true
    this.panes.delete(id)
  }

  issue(edit: Edit) {
    const pane = this.panes.get(edit.paneID)
    if (!pane || pane.closed || !pane.current() || pane.agentID !== edit.agentID)
      refused("This worker conversation changed. Reload its draft before saving.")
    if (pane.owner !== edit.owner || pane.conversationID !== edit.conversationID)
      refused("This draft belongs to a different saved conversation.")
    if (edit.draft !== null && (typeof edit.draft !== "string" || edit.draft.length > 8000))
      refused("Inbox drafts are limited to 8000 characters.")
    if (!number(edit.sequence, 1) || edit.sequence <= pane.sequence || !number(edit.expectedRevision, 0))
      refused("This draft edit is out of order. Reload the conversation.")
    if (pane.failures.size)
      refused("The previous draft save is uncertain. Reload this conversation before saving again.")
    if (pane.pending.size || pane.flushing || pane.sending || edit.expectedRevision !== pane.revision)
      refused("Wait for the previous draft save before editing this conversation again.")
    pane.sequence = edit.sequence
    let resolve!: () => void
    let reject!: (error: Error) => void
    const pending = new Promise<void>((yes, no) => {
      resolve = yes
      reject = no
    })
    void pending.catch(() => undefined)
    pane.pending.set(edit.sequence, pending)
    let settled = false
    let files: string[] | undefined
    return {
      before: (ids: string[]) => {
        if (pane.closed || !pane.current() || this.panes.get(edit.paneID) !== pane)
          refused("This worker conversation changed while preparing its draft.")
        if (!Array.isArray(ids) || ids.length > 8 || ids.some((id) => !valid(id)) || new Set(ids).size !== ids.length)
          refused("Reload the conversation before changing its attachments.")
        files = ids
      },
      settle: (ack?: RoutineDraftProof) => {
        if (settled) return
        settled = true
        pane.pending.delete(edit.sequence)
        if (
          !ack ||
          pane.closed ||
          !pane.current() ||
          this.panes.get(edit.paneID) !== pane ||
          ack.owner !== pane.owner ||
          ack.conversationID !== pane.conversationID ||
          ack.revision !== edit.expectedRevision + 1 ||
          ack.draft !== edit.draft ||
          !files ||
          !same(
            (ack.attachments ?? []).map((file) => file.id),
            files,
          )
        ) {
          pane.failures.add(edit.sequence)
          reject(new Error("The saved draft could not be verified. Reload this conversation."))
          return
        }
        pane.revision = ack.revision
        pane.confirmed = edit.sequence
        resolve()
      },
    }
  }

  private scope(
    id: string,
    identity: Pick<Scope, "agentID" | "owner" | "conversationID">,
    snapshot: Snapshot,
    deadline: number,
  ) {
    const pane = this.panes.get(id)
    if (
      !pane ||
      pane.agentID !== identity.agentID ||
      pane.owner !== identity.owner ||
      pane.conversationID !== identity.conversationID ||
      pane.closed ||
      !pane.current() ||
      !number(snapshot.cutoff, 0) ||
      !number(deadline, 1)
    )
      refused("This conversation changed before its draft could be confirmed.")
    if (
      pane.flushing ||
      pane.sending ||
      snapshot.cutoff < pane.sequence ||
      (snapshot.draft !== null && (typeof snapshot.draft !== "string" || snapshot.draft.length > 8000))
    )
      refused("The latest draft edit could not be confirmed.")
    if (
      !Array.isArray(snapshot.attachmentIDs) ||
      snapshot.attachmentIDs.length > 8 ||
      snapshot.attachmentIDs.some((value) => !valid(value)) ||
      new Set(snapshot.attachmentIDs).size !== snapshot.attachmentIDs.length
    )
      refused("Reload the conversation before confirming its attachments.")
    return pane
  }

  private async join(pane: Pane, cutoff: number, deadline: number) {
    const pending = [...pane.pending.entries()].filter(([sequence]) => sequence <= cutoff).map(([, task]) => task)
    const results = await bounded(Promise.allSettled(pending), deadline)
    if (results.some((result) => result.status === "rejected")) refused("The draft save was not confirmed.")
    if (
      pane.failures.size ||
      pane.confirmed !== pane.sequence ||
      pane.closed ||
      !pane.current() ||
      Date.now() >= deadline
    )
      refused("The draft save was not confirmed.")
  }

  async flush(
    id: string,
    identity: Pick<Scope, "agentID" | "owner" | "conversationID">,
    snapshot: Snapshot,
    deadline: number,
  ) {
    const pane = this.scope(id, identity, snapshot, deadline)
    pane.flushing = true
    try {
      await this.join(pane, snapshot.cutoff, deadline)
      const prior = proof(pane, await bounded(pane.read(), deadline), pane.revision, deadline)
      if (snapshot.cutoff > pane.sequence || !content(prior, snapshot)) {
        const ack = proof(
          pane,
          await bounded(pane.write(snapshot.draft, snapshot.attachmentIDs, pane.revision), deadline),
          pane.revision + 1,
          deadline,
        )
        if (!content(ack, snapshot)) refused("The final draft save was not confirmed.")
        pane.revision = ack.revision
        pane.sequence = snapshot.cutoff
        pane.confirmed = snapshot.cutoff
      }
      const ack = proof(pane, await bounded(pane.read(), deadline), pane.revision, deadline)
      if (!content(ack, snapshot)) refused("The saved conversation changed before confirmation.")
      pane.cutoff = snapshot.cutoff
      return ack
    } catch (error) {
      pane.failures.add(snapshot.cutoff)
      throw error
    } finally {
      pane.flushing = false
    }
  }

  send(id: string, identity: Pick<Scope, "agentID" | "owner" | "conversationID">) {
    const pane = this.panes.get(id)
    if (
      !pane ||
      pane.agentID !== identity.agentID ||
      pane.owner !== identity.owner ||
      pane.conversationID !== identity.conversationID ||
      pane.closed ||
      !pane.current() ||
      pane.pending.size ||
      pane.failures.size ||
      pane.flushing ||
      pane.sending ||
      pane.cutoff !== pane.sequence
    )
      refused("Confirm this worker draft before sending it.")
    const revision = pane.revision
    let resolve!: () => void
    let reject!: (error: Error) => void
    const pending = new Promise<void>((yes, no) => {
      resolve = yes
      reject = no
    })
    void pending.catch(() => undefined)
    pane.sending = pending
    let settled = false
    let confirmed = false
    return {
      before: () => {
        if (pane.closed || !pane.current() || this.panes.get(id) !== pane || pane.revision !== revision)
          refused("This worker conversation changed before its message was sent.")
      },
      settle: (ack?: RoutineDraftProof) => {
        if (settled) return confirmed
        settled = true
        pane.sending = undefined
        if (
          !ack ||
          pane.closed ||
          !pane.current() ||
          this.panes.get(id) !== pane ||
          ack.owner !== pane.owner ||
          ack.conversationID !== pane.conversationID ||
          !number(ack.revision, revision)
        ) {
          pane.failures.add(pane.sequence)
          reject(new Error("The sent message could not be reconciled with this draft."))
          return false
        }
        pane.revision = ack.revision
        pane.cutoff = undefined
        confirmed = true
        resolve()
        return true
      },
    }
  }

  async drain(deadline: number) {
    const panes = [...this.panes.values()]
    const results = await Promise.allSettled(
      panes.map(async (pane) => {
        const pending = [...pane.pending.values(), ...(pane.sending ? [pane.sending] : [])]
        if (pending.length) {
          const timeout = Math.max(0, deadline - Date.now())
          if (!timeout) refused("Routine draft shutdown flush timed out.")
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            const limit = new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Routine draft shutdown flush timed out.")), timeout)
            })
            const results = await Promise.race([Promise.allSettled(pending), limit])
            if (results.some((result) => result.status === "rejected"))
              refused("A Routine draft save failed during shutdown.")
          } finally {
            if (timer) clearTimeout(timer)
          }
        }
        if (pane.sequence && pane.cutoff !== pane.sequence) refused("A mounted Routine draft has no final edit cutoff.")
        if (!pane.current() || pane.closed || pane.failures.size || pane.confirmed !== pane.sequence)
          refused("A Routine draft could not be verified during shutdown.")
        const timeout = Math.max(0, deadline - Date.now())
        if (!timeout) refused("Routine draft shutdown proof timed out.")
        let timer: ReturnType<typeof setTimeout> | undefined
        const limit = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Routine draft shutdown proof timed out.")), timeout)
        })
        const ack = await Promise.race([pane.read(), limit]).finally(() => {
          if (timer) clearTimeout(timer)
        })
        if (
          !ack ||
          ack.owner !== pane.owner ||
          ack.conversationID !== pane.conversationID ||
          ack.revision !== pane.revision ||
          pane.closed ||
          !pane.current() ||
          Date.now() >= deadline
        )
          refused("The mounted Routine draft changed during shutdown.")
        return ack
      }),
    )
    return results.every((result) => result.status === "fulfilled")
  }
}
