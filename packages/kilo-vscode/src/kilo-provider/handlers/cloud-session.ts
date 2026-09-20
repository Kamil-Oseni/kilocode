/**
 * Cloud session handlers — extracted from KiloProvider.
 *
 * Manages fetching cloud sessions, previewing them, and the "import + send"
 * flow that clones a cloud session locally on first message. No vscode dependency.
 */

import type { KiloClient, Session, TextPartInput, FilePartInput } from "@kilocode/sdk/v2/client"
import type { CloudSessionData, EditorContext } from "../../services/cli-backend/types"
import { sessionToWebview, mapCloudSessionMessageToWebviewMessage } from "../../kilo-provider-utils"
import type { MessageFile } from "../message-files"
import { reviewMetadata, type ReviewMessageData } from "../../shared/review-comments"
import { completesWithoutStatus } from "../command-completion"
import type { CloudContinuationRecord } from "../../services/cloud-continuation-journal"

export interface CloudContinuation {
  cloud: string
  id: string
  requestID: string
  directory: string
  client: KiloClient
  generation: number
  revision: number
  status: "preview" | "pending" | "uncertain" | "imported"
  session?: Session
  sessionID?: string
}

const TIMEOUT = 30_000

export interface CloudSessionContext {
  readonly client: KiloClient | null
  readonly journal: {
    get(key: string): Promise<CloudContinuationRecord | undefined>
    claim(
      key: string,
      record: CloudContinuationRecord,
    ): Promise<{ acquired: boolean; record: CloudContinuationRecord }>
    complete(key: string, claim: string, sessionID: string): Promise<void>
    clear(key: string, claim: string): Promise<boolean>
  }
  readonly generation: number
  readonly continuations: Map<string, CloudContinuation>
  currentSession: Session | null
  readonly trackedSessionIds: Set<string>
  readonly connectionService: {
    recordMessageSessionId(messageId: string, sessionId: string): void
  }
  postMessage(msg: unknown): void
  getWorkspaceDirectory(sessionId?: string): string
  gatherEditorContext(): Promise<EditorContext>
  runWithMessageConfirmation?<T>(
    messageID: string | undefined,
    label: string,
    run: () => Promise<T>,
  ): Promise<T | undefined>
}

function retained(
  previous: CloudContinuation | undefined,
  directory: string,
  client: KiloClient,
  generation: number,
  saved: CloudContinuationRecord | undefined,
) {
  return (
    !!previous &&
    previous.directory === directory &&
    previous.client === client &&
    previous.generation === generation &&
    previous.status !== "preview" &&
    saved !== undefined
  )
}

/** Fetch cloud sessions list and send to webview. */
export async function handleRequestCloudSessions(
  ctx: CloudSessionContext,
  message: { requestID: string; cursor?: string; limit?: number; gitUrl?: string },
): Promise<void> {
  const fail = (error: string) => ctx.postMessage({ type: "cloudSessionsFailed", requestID: message.requestID, error })
  if (!ctx.client) {
    fail("Cloud history is disconnected. Reconnect and retry.")
    return
  }

  try {
    const result = await ctx.client.kilo.cloudSessions(
      { cursor: message.cursor, limit: message.limit, gitUrl: message.gitUrl },
      { signal: AbortSignal.timeout(TIMEOUT) },
    )
    if (
      result.error ||
      !result.data ||
      !Array.isArray(result.data.cliSessions) ||
      !result.data.cliSessions.every(
        (item) =>
          !!item &&
          typeof item === "object" &&
          typeof item.session_id === "string" &&
          !!item.session_id &&
          typeof item.updated_at === "string" &&
          typeof item.created_at === "string" &&
          typeof item.version === "number" &&
          Number.isFinite(item.version) &&
          (item.title === null || item.title === undefined || typeof item.title === "string"),
      ) ||
      (result.data.nextCursor !== null &&
        result.data.nextCursor !== undefined &&
        typeof result.data.nextCursor !== "string")
    ) {
      fail("Cloud history could not be loaded. Retry when the connection is available.")
      return
    }

    ctx.postMessage({
      type: "cloudSessionsLoaded",
      requestID: message.requestID,
      sessions: result.data.cliSessions,
      nextCursor: result.data.nextCursor ?? null,
    })
  } catch (error) {
    console.error("[Raya] Provider: Failed to fetch cloud sessions:", error)
    fail("Cloud history could not be loaded. Retry when the connection is available.")
  }
}

/**
 * Fetch full cloud session data for read-only preview.
 * Transforms the export data into webview message format and sends it back.
 */
export async function handleRequestCloudSessionData(
  ctx: CloudSessionContext,
  sessionId: string,
  requestID: string,
): Promise<void> {
  const client = ctx.client
  const fail = (error: string) =>
    ctx.postMessage({ type: "cloudSessionImportFailed", cloudSessionId: sessionId, requestID, error })
  if (!client) return fail("Not connected to CLI backend")
  const directory = ctx.getWorkspaceDirectory()
  const generation = ctx.generation
  const entry: CloudContinuation = {
    cloud: sessionId,
    id: crypto.randomUUID(),
    requestID,
    directory,
    client,
    generation,
    revision: 0,
    status: "preview",
  }
  const read = await ctx.journal.get(JSON.stringify([sessionId, directory])).then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  if ("error" in read) {
    console.error("[Raya] Could not read cloud import recovery state:", read.error)
    return fail("Cloud continuation recovery data could not be read. Nothing was imported.")
  }
  const saved = read.value
  if (saved) {
    entry.id = saved.claim
    entry.revision = saved.revision
    entry.status = saved.sessionID ? "imported" : "uncertain"
    entry.sessionID = saved.sessionID
  }
  const previous = ctx.continuations.get(sessionId)
  // Never erase an unresolved mutation when a preview is reopened.
  const reusable = retained(previous, directory, client, generation, saved)
  if (!reusable) ctx.continuations.set(sessionId, entry)
  if (saved) {
    const ticket = ctx.continuations.get(sessionId)!
    ctx.postMessage({
      type: "cloudSessionDataLoaded",
      cloudSessionId: sessionId,
      requestID,
      title: "Cloud session recovery",
      messages: [],
      continuation: {
        id: ticket.id,
        directory: ticket.directory,
        revision: ticket.revision,
        status: ticket.status,
        sessionID: ticket.session?.id ?? ticket.sessionID,
      },
    })
  }
  const current = () =>
    ctx.client === client && ctx.generation === generation && ctx.getWorkspaceDirectory() === directory
  try {
    const result = await client.kilo.cloud.session.get({ id: sessionId }, { signal: AbortSignal.timeout(TIMEOUT) })
    if (!current()) return fail("The destination changed. Reopen this cloud preview to choose the current environment.")
    if (!reusable && ctx.continuations.get(sessionId) !== entry) return
    const data = result.data as CloudSessionData | undefined
    if (!data) return fail("Failed to fetch cloud session")
    if (!Number.isFinite(data.info.time?.updated))
      return fail("Cloud preview has no stable revision. Refresh it before continuing.")
    entry.revision = data.info.time.updated
    const messages = (data.messages ?? []).filter((m) => m.info).map(mapCloudSessionMessageToWebviewMessage)
    const ticket = ctx.continuations.get(sessionId)!
    ctx.postMessage({
      type: "cloudSessionDataLoaded",
      cloudSessionId: sessionId,
      requestID,
      title: data.info.title ?? "Untitled",
      messages,
      continuation: {
        id: ticket.id,
        directory: ticket.directory,
        revision: ticket.revision,
        status: ticket.status,
        sessionID: ticket.session?.id ?? ticket.sessionID,
      },
    })
  } catch (err) {
    console.error("[Raya] Failed to load cloud session data:", err)
    fail("Failed to load cloud preview. Reopen it to retry.")
  }
}

export async function handleResetCloudContinuation(
  ctx: CloudSessionContext,
  cloud: string,
  continuationID: string,
  requestID: string,
): Promise<void> {
  const ticket = ctx.continuations.get(cloud)
  const fail = (error: string) =>
    ctx.postMessage({
      type: "cloudSessionImportFailed",
      cloudSessionId: cloud,
      continuationID,
      requestID,
      status: ticket?.status,
      sessionID: ticket?.sessionID,
      error,
    })
  if (!ticket || ticket.id !== continuationID || ticket.status !== "uncertain") {
    fail("This recovery state changed. Reopen the cloud preview before allowing a new copy.")
    return
  }
  if (
    ctx.client !== ticket.client ||
    ctx.generation !== ticket.generation ||
    ctx.getWorkspaceDirectory() !== ticket.directory
  ) {
    fail("The destination changed. The recovery reservation was retained; reopen the cloud preview.")
    return
  }
  const key = JSON.stringify([ticket.cloud, ticket.directory])
  const cleared = await ctx.journal.clear(key, ticket.id).catch((error) => {
    console.error("[Raya] Could not reset cloud continuation recovery state:", error)
    return false
  })
  if (!cleared) {
    fail("The recovery reservation changed and was retained. Reopen the cloud preview.")
    return
  }
  ctx.continuations.delete(cloud)
  await handleRequestCloudSessionData(ctx, cloud, requestID)
}

export function handleCloudSessionRequest(
  ctx: CloudSessionContext,
  cloud: string,
  requestID: string,
  continuationID?: string,
) {
  if (continuationID) return handleResetCloudContinuation(ctx, cloud, continuationID, requestID)
  return handleRequestCloudSessionData(ctx, cloud, requestID)
}

function matches(ctx: CloudSessionContext, selected: Session | null, current: () => boolean) {
  return current() && ctx.currentSession === selected
}

async function release(ctx: CloudSessionContext, ticket: CloudContinuation) {
  const key = JSON.stringify([ticket.cloud, ticket.directory])
  await ctx.journal.clear(key, ticket.id).catch((error) => {
    console.error("[Raya] Could not clear unused import recovery state:", error)
  })
  ticket.status = "preview"
}

async function reserve(
  ctx: CloudSessionContext,
  ticket: CloudContinuation,
  selected: Session | null,
  current: () => boolean,
  fail: (error: string) => void,
) {
  const key = JSON.stringify([ticket.cloud, ticket.directory])
  ticket.status = "pending"
  const result = await ctx.journal
    .claim(key, { claim: ticket.id, revision: ticket.revision, created: Date.now() })
    .catch((error) => {
      console.error("[Raya] Could not save import recovery state:", error)
      return undefined
    })
  if (!result) {
    ticket.status = "preview"
    fail("Could not save import recovery state. Nothing was imported.")
    return false
  }
  if (!result.acquired) {
    ticket.status = result.record.sessionID ? "imported" : "uncertain"
    ticket.sessionID = result.record.sessionID
    fail("A continuation was already requested for this destination. Check Local history before creating another copy.")
    return false
  }
  if (matches(ctx, selected, current)) return true
  await release(ctx, ticket)
  fail("The destination changed before import. Nothing was imported. Reopen the preview.")
  return false
}

async function rejectImport(
  ctx: CloudSessionContext,
  ticket: CloudContinuation,
  result: { error?: unknown; response: { status: number } },
  fail: (error: string) => void,
) {
  if (!result.error) return false
  if (result.response.status === 409) {
    await release(ctx, ticket)
    fail("The cloud session changed after this preview. Reopen it before creating a local copy.")
    return true
  }
  ticket.status = "uncertain"
  fail("Import outcome unknown. Check Local history; retrying could create another copy.")
  return true
}

/**
 * Import a cloud session to local storage, then send a new message on it.
 * This is the "clone on first message" flow — the cloud session becomes a
 * local session only when the user decides to continue it.
 */
export async function handleImportAndSend(
  ctx: CloudSessionContext,
  cloudSessionId: string,
  text: string,
  messageID?: string,
  providerID?: string,
  modelID?: string,
  agent?: string,
  variant?: string,
  files?: MessageFile[],
  review?: ReviewMessageData,
  command?: string,
  commandArgs?: string,
  continuationID?: string,
): Promise<void> {
  const ticket = ctx.continuations.get(cloudSessionId)
  const fail = (error: string) => {
    ctx.postMessage({
      type: "cloudSessionImportFailed",
      cloudSessionId,
      continuationID,
      error,
      status: ticket?.status,
      sessionID: ticket?.session?.id ?? ticket?.sessionID,
    })
    ctx.postMessage({
      type: "sendMessageFailed",
      error,
      text,
      sessionID: `cloud:${cloudSessionId}`,
      draftID: `cloud:${cloudSessionId}`,
      messageID,
      files,
      review: command ? undefined : review,
    })
  }
  if (!ticket || ticket.id !== continuationID) return fail("Reopen this cloud preview before continuing.")
  const selected = ctx.currentSession
  const client = ticket.client
  const dir = ticket.directory
  const current = () =>
    ctx.client === client && ctx.generation === ticket.generation && ctx.getWorkspaceDirectory() === dir
  if (!current()) return fail("The destination changed. Reopen this cloud preview before continuing.")
  if (ticket.status !== "preview")
    return fail(
      ticket.status === "imported"
        ? "A local copy already exists. Open it from Local history to continue."
        : "The previous import is pending or its outcome is unknown. Check Local history before creating another copy.",
    )

  if (!(await reserve(ctx, ticket, selected, current, fail))) return
  if (!matches(ctx, selected, current)) {
    await release(ctx, ticket)
    return fail("The destination changed before import. Nothing was imported. Reopen the preview.")
  }
  let session: Session | undefined
  try {
    const result = await client.kilo.cloud.session.import(
      { sessionId: cloudSessionId, expectedUpdated: ticket.revision, directory: dir },
      { signal: AbortSignal.timeout(TIMEOUT) },
    )
    if (await rejectImport(ctx, ticket, result, fail)) return
    session = result.data as Session | undefined
  } catch (error) {
    ticket.status = "uncertain"
    console.error("[Raya] Cloud session import outcome unknown:", error)
    return fail("Import outcome unknown. Check Local history; retrying could create another copy.")
  }
  if (!session?.id) {
    ticket.status = "uncertain"
    return fail("Import was not acknowledged. Check Local history before creating another copy.")
  }
  ticket.status = "imported"
  ticket.session = session
  await ctx.journal.complete(JSON.stringify([cloudSessionId, dir]), ticket.id, session.id).catch((error) => {
    console.error("[Raya] Failed to save known local cloud copy:", error)
  })
  if (!matches(ctx, selected, current))
    return fail(
      "A local copy was created in " +
        dir +
        ", but the environment changed. Open it from Local history; your message was not sent.",
    )

  ctx.currentSession = session
  ctx.trackedSessionIds.add(session.id)
  ctx.postMessage({ type: "cloudSessionImported", cloudSessionId, continuationID, session: sessionToWebview(session) })

  // Step 2: Send the user's message/command on the new local session
  const run = ctx.runWithMessageConfirmation ?? ((_id, _label, fn) => fn())
  try {
    await run(messageID, "Cloud import send", async () => {
      if (!current() || ctx.currentSession !== session)
        throw new Error("The environment changed after import. Your message was not sent.")
      if (messageID) {
        ctx.connectionService.recordMessageSessionId(messageID, session.id)
      }

      if (command) {
        const parts = files?.map((f) => ({
          type: "file" as const,
          mime: f.mime,
          url: f.url,
          filename: f.filename,
          source: f.source,
        }))
        await client.session.command(
          {
            sessionID: session.id,
            directory: dir,
            command,
            arguments: commandArgs ?? "",
            messageID,
            model: providerID && modelID ? `${providerID}/${modelID}` : undefined,
            agent,
            variant,
            parts,
          },
          { throwOnError: true },
        )
        return
      }

      const parts: Array<TextPartInput | FilePartInput> = []
      if (files) {
        for (const f of files) {
          parts.push({ type: "file", mime: f.mime, url: f.url, filename: f.filename, source: f.source })
        }
      }
      parts.push({ type: "text", text, metadata: review ? reviewMetadata(review) : undefined })

      const editorContext = await ctx.gatherEditorContext()
      if (!current() || ctx.currentSession !== session)
        throw new Error("The environment changed after import. Your message was not sent.")
      await client.session.promptAsync(
        {
          sessionID: session.id,
          directory: dir,
          messageID,
          parts,
          model: providerID && modelID ? { providerID, modelID } : undefined,
          agent,
          variant,
          editorContext,
        },
        { throwOnError: true },
      )
    })
    if (messageID && command && completesWithoutStatus(command)) {
      ctx.postMessage({ type: "sessionCommandCompleted", messageID })
    }
  } catch (err) {
    console.error("[Raya] Failed to send message after cloud import:", err)
    ctx.postMessage({
      type: "sendMessageFailed",
      error: err instanceof Error ? err.message : "Failed to send message after import",
      text,
      sessionID: session.id,
      draftID: session.id,
      messageID,
      files,
      review: command ? undefined : review,
    })
  }
}
