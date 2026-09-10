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

export interface CloudContinuation {
  cloud: string
  id: string
  requestID: string
  directory: string
  client: KiloClient
  generation: number
  status: "preview" | "pending" | "uncertain" | "imported"
  session?: Session
  sessionID?: string
}

const TIMEOUT = 30_000

export interface CloudSessionContext {
  readonly client: KiloClient | null
  readonly journal: {
    get(key: string): { sessionID?: string } | undefined
    update(key: string, record?: { sessionID?: string }): Promise<void>
  }
  readonly claims: Set<string>
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
    console.error("[Kilo New] KiloProvider: Failed to fetch cloud sessions:", error)
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
    status: "preview",
  }
  const saved = ctx.journal.get(JSON.stringify([sessionId, directory]))
  if (saved) {
    entry.status = saved.sessionID ? "imported" : "uncertain"
    entry.sessionID = saved.sessionID
  }
  const previous = ctx.continuations.get(sessionId)
  // Never erase an unresolved mutation when a preview is reopened.
  const reusable =
    previous &&
    previous.directory === directory &&
    previous.client === client &&
    previous.generation === generation &&
    previous.status !== "preview" &&
    (saved !== undefined || ctx.claims.has(JSON.stringify([sessionId, directory])))
  if (!reusable) ctx.continuations.set(sessionId, entry)
  const current = () =>
    ctx.client === client && ctx.generation === generation && ctx.getWorkspaceDirectory() === directory
  try {
    const result = await client.kilo.cloud.session.get({ id: sessionId }, { signal: AbortSignal.timeout(TIMEOUT) })
    if (!current()) return fail("The destination changed. Reopen this cloud preview to choose the current environment.")
    if (!reusable && ctx.continuations.get(sessionId) !== entry) return
    const data = result.data as CloudSessionData | undefined
    if (!data) return fail("Failed to fetch cloud session")
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
        status: ticket.status,
        sessionID: ticket.session?.id ?? ticket.sessionID,
      },
    })
  } catch (err) {
    console.error("[Kilo New] Failed to load cloud session data:", err)
    fail("Failed to load cloud preview. Reopen it to retry.")
  }
}

function matches(ctx: CloudSessionContext, selected: Session | null, current: () => boolean) {
  return current() && ctx.currentSession === selected
}

async function release(ctx: CloudSessionContext, ticket: CloudContinuation) {
  const key = JSON.stringify([ticket.cloud, ticket.directory])
  await ctx.journal.update(key).catch((error) => {
    console.error("[Kilo New] Could not clear unused import recovery state:", error)
  })
  ctx.claims.delete(key)
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
  const saved = ctx.journal.get(key)
  if (ctx.claims.has(key) || saved) {
    ticket.status = saved?.sessionID ? "imported" : "uncertain"
    ticket.sessionID = saved?.sessionID
    fail("A continuation was already requested for this destination. Check Local history before creating another copy.")
    return false
  }
  // Reserve synchronously across every view in this extension host before awaiting storage.
  ctx.claims.add(key)
  ticket.status = "pending"
  try {
    await ctx.journal.update(key, {})
  } catch (error) {
    ctx.claims.delete(key)
    ticket.status = "preview"
    console.error("[Kilo New] Could not save import recovery state:", error)
    fail("Could not save import recovery state. Nothing was imported.")
    return false
  }
  if (matches(ctx, selected, current)) return true
  await release(ctx, ticket)
  fail("The destination changed before import. Nothing was imported. Reopen the preview.")
  return false
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
      { sessionId: cloudSessionId, directory: dir },
      { signal: AbortSignal.timeout(TIMEOUT) },
    )
    session = result.data as Session | undefined
  } catch (error) {
    ticket.status = "uncertain"
    console.error("[Kilo New] Cloud session import outcome unknown:", error)
    return fail("Import outcome unknown. Check Local history; retrying could create another copy.")
  }
  if (!session?.id) {
    ticket.status = "uncertain"
    return fail("Import was not acknowledged. Check Local history before creating another copy.")
  }
  ticket.status = "imported"
  ticket.session = session
  await ctx.journal.update(JSON.stringify([cloudSessionId, dir]), { sessionID: session.id }).catch((error) => {
    console.error("[Kilo New] Failed to save known local cloud copy:", error)
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
    console.error("[Kilo New] Failed to send message after cloud import:", err)
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
