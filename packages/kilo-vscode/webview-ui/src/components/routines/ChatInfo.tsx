import { Component, For, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { useVSCode } from "../../context/vscode"
import type { ExtensionMessage } from "../../types/messages"
import { MediaAttachment, previewable } from "./MediaAttachment"

type Share = {
  kind: "file" | "link" | "attachment"
  messageID: string
  label: string
  time: number
  path?: string
  url?: string
  sessionID?: string
  attachmentID?: string
  mime?: string
  size?: number
}

type Contact = {
  peerID: string
  name: string
  role: string
  archived: boolean
  direction: "sent" | "received"
  delegationID: string
  organizationID?: string
  organizationName?: string
  organizationRevision?: number
  state: string
  objective: string
  expected?: string
  context?: string
  updated: number
  response?: string
  reason?: string
  cost?: number
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function validShare(value: unknown): value is Share {
  if (!value || typeof value !== "object") return false
  const row = value as Record<string, unknown>
  if (row.kind !== "file" && row.kind !== "link" && row.kind !== "attachment") return false
  if (typeof row.messageID !== "string" || typeof row.label !== "string" || !finite(row.time)) return false
  if (row.sessionID !== undefined && typeof row.sessionID !== "string") return false
  if (row.kind === "file") return typeof row.path === "string"
  if (row.kind === "attachment")
    return (
      typeof row.attachmentID === "string" &&
      typeof row.mime === "string" &&
      typeof row.size === "number" &&
      Number.isFinite(row.size)
    )
  return typeof row.url === "string" && /^https?:\/\//i.test(row.url)
}

function optionalText(row: Record<string, unknown>, keys: string[]) {
  return keys.every((key) => row[key] === undefined || typeof row[key] === "string")
}

function provenance(row: Record<string, unknown>) {
  if (row.organizationID === undefined)
    return row.organizationName === undefined && row.organizationRevision === undefined
  return (
    typeof row.organizationID === "string" &&
    /^org_[a-f0-9]{32}$/.test(row.organizationID) &&
    typeof row.organizationName === "string" &&
    !!row.organizationName.trim() &&
    typeof row.organizationRevision === "number" &&
    Number.isSafeInteger(row.organizationRevision) &&
    row.organizationRevision >= 1
  )
}

function validContact(value: unknown): value is Contact {
  if (!value || typeof value !== "object") return false
  const row = value as Record<string, unknown>
  if (!optionalText(row, ["expected", "context", "response", "reason"])) return false
  if (row.cost !== undefined && (typeof row.cost !== "number" || !Number.isFinite(row.cost))) return false
  if (!provenance(row)) return false
  return (
    typeof row.peerID === "string" &&
    typeof row.name === "string" &&
    typeof row.role === "string" &&
    typeof row.archived === "boolean" &&
    (row.direction === "sent" || row.direction === "received") &&
    typeof row.delegationID === "string" &&
    typeof row.state === "string" &&
    typeof row.objective === "string" &&
    finite(row.updated)
  )
}

function stamp(at: number) {
  return new Date(at).toLocaleString()
}

function bytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

const ReportSetting: Component<{ agentID: string; connected: boolean }> = (props) => {
  const vscode = useVSCode()
  const [busy, setBusy] = createSignal(true)
  const [enabled, setEnabled] = createSignal(false)
  const [error, setError] = createSignal("")
  let id = ""
  const request = (action: "load" | "enable" | "disable") => {
    if (!props.connected) {
      setBusy(false)
      setError("Reconnect to review report access.")
      return
    }
    id = crypto.randomUUID()
    setBusy(true)
    setError("")
    vscode.postMessage({ type: "routineContactDestination", requestID: id, agentID: props.agentID, action })
  }
  const receive = (msg: ExtensionMessage) => {
    if (msg.type !== "routineContactDestination" || msg.agentID !== props.agentID || msg.requestID !== id) return
    setBusy(false)
    if (msg.error) {
      setError(msg.error)
      return
    }
    setEnabled(msg.enabled === true)
    setError("")
  }
  const unsub = vscode.onMessage(receive)
  onCleanup(unsub)
  onMount(() => request("load"))
  const toggle = () => {
    if (busy() || !props.connected) return
    request(enabled() ? "disable" : "enable")
  }
  return (
    <section class="routines-info-section" aria-labelledby="routine-info-reports">
      <h3 id="routine-info-reports">Reports to you</h3>
      <div class="routines-info-setting">
        <div>
          <strong>Raya inbox</strong>
          <span>
            {enabled()
              ? "This worker can send reports to this conversation."
              : "Allow this worker to send reports to this conversation."}
          </span>
        </div>
        <Button
          size="small"
          variant="secondary"
          disabled={!props.connected}
          aria-disabled={busy() || !props.connected}
          aria-busy={busy()}
          onClick={toggle}
        >
          {busy() ? "Checking..." : enabled() ? "Stop reports" : "Allow reports"}
        </Button>
      </div>
      {error() ? (
        <div class="routines-info-retry">
          <p class="routines-error" role="alert">
            {error()}
          </p>
          <Button
            size="small"
            variant="ghost"
            disabled={!props.connected}
            aria-disabled={busy() || !props.connected}
            onClick={() => request("load")}
          >
            Retry
          </Button>
        </div>
      ) : null}
    </section>
  )
}

export const ChatInfo: Component<{
  agentID: string
  name: string
  role: string
  objective: string
  schedule: string
  access: string
  output: string
  state: string
  workspace?: string
  enabled: boolean
  canInspect: boolean
  connected: boolean
  onEdit: () => void
  onAccess: () => void
  onOutput: () => void
  onInspect: () => void
  onToggle: () => void
  onLocate: (id: string, label: string) => void
  onTrace: (id: string, name: string) => void
}> = (props) => {
  const vscode = useVSCode()
  const [shares, setShares] = createSignal<Share[]>([])
  const [contacts, setContacts] = createSignal<Contact[]>([])
  const [shareNext, setShareNext] = createSignal<string>()
  const [contactNext, setContactNext] = createSignal<string>()
  const [shareError, setShareError] = createSignal("")
  const [contactError, setContactError] = createSignal("")
  const [shareBusy, setShareBusy] = createSignal(true)
  const [contactBusy, setContactBusy] = createSignal(true)
  let shareID = ""
  let contactID = ""
  const after: { shares?: string; contacts?: string } = {}

  const load = (section: "shares" | "contacts", cursor?: string) => {
    const id = crypto.randomUUID()
    after[section] = cursor
    if (section === "shares") {
      shareID = id
      setShareBusy(true)
      setShareError("")
    } else {
      contactID = id
      setContactBusy(true)
      setContactError("")
    }
    vscode.postMessage({
      type: "routineInboxInfo",
      requestID: id,
      agentID: props.agentID,
      section,
      ...(cursor ? { cursor } : {}),
    })
  }

  onMount(() => {
    load("shares")
    load("contacts")
  })

  const receive = (msg: ExtensionMessage) => {
    if (msg.type !== "routineInboxInfo" || msg.agentID !== props.agentID) return
    if (msg.section === "shares") {
      if (msg.requestID !== shareID) return
      setShareBusy(false)
      if (msg.error) {
        setShareError(msg.error)
        return
      }
      const rows = (msg.items ?? []).filter(validShare)
      setShares((prior) => [
        ...prior,
        ...rows.filter(
          (row) =>
            !prior.some(
              (item) => item.kind === row.kind && item.messageID === row.messageID && item.label === row.label,
            ),
        ),
      ])
      setShareNext(msg.next)
      return
    }
    if (msg.requestID !== contactID) return
    setContactBusy(false)
    if (msg.error) {
      setContactError(msg.error)
      return
    }
    const rows = (msg.items ?? []).filter(validContact)
    setContacts((prior) => [
      ...prior,
      ...rows.filter(
        (row) => !prior.some((item) => item.delegationID === row.delegationID && item.direction === row.direction),
      ),
    ])
    setContactNext(msg.next)
  }

  const unsub = vscode.onMessage(receive)
  onCleanup(unsub)

  const media = createMemo(() => shares().filter((item) => item.kind === "attachment" && previewable(item.mime ?? "")))
  const files = createMemo(() =>
    shares().filter((item) => item.kind === "file" || (item.kind === "attachment" && !previewable(item.mime ?? ""))),
  )
  const links = createMemo(() => shares().filter((item) => item.kind === "link"))

  return (
    <div class="routines-info" aria-label={`Chat info for ${props.name}`}>
      <section class="routines-info-section" aria-labelledby="routine-info-about">
        <h3 id="routine-info-about">About</h3>
        <p class="routines-info-objective">{props.objective}</p>
        <dl class="routines-info-facts">
          <div>
            <dt>Role</dt>
            <dd>{props.role}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{props.state}</dd>
          </div>
          <div>
            <dt>Schedule</dt>
            <dd>{props.schedule}</dd>
          </div>
          <div>
            <dt>Access</dt>
            <dd>{props.access}</dd>
          </div>
          <div>
            <dt>Output</dt>
            <dd>{props.output}</dd>
          </div>
          {props.workspace ? (
            <div>
              <dt>Folder</dt>
              <dd>{props.workspace}</dd>
            </div>
          ) : null}
        </dl>
        <div class="routines-info-actions" aria-label="Worker settings">
          <Button size="small" variant="ghost" onClick={props.onEdit}>
            Edit schedule
          </Button>
          <Button size="small" variant="ghost" onClick={props.onAccess}>
            Review access
          </Button>
          <Button size="small" variant="ghost" onClick={props.onOutput}>
            Review output
          </Button>
          <Button size="small" variant="ghost" disabled={!props.canInspect} onClick={props.onInspect}>
            Review runs
          </Button>
          <Button size="small" variant="ghost" onClick={props.onToggle}>
            {props.enabled ? "Pause" : "Enable"}
          </Button>
        </div>
      </section>

      <ReportSetting agentID={props.agentID} connected={props.connected} />

      <section class="routines-info-section" aria-labelledby="routine-info-media">
        <h3 id="routine-info-media">Media</h3>
        {media().length ? (
          <ul class="routines-info-media" aria-label="Shared media">
            <For each={media()}>
              {(item) => (
                <MediaAttachment
                  agentID={props.agentID}
                  file={{ id: item.attachmentID!, name: item.label, mime: item.mime!, size: item.size! }}
                  detail={stamp(item.time)}
                  locateDisabled={!props.connected}
                  onLocate={() => props.onLocate(item.messageID, item.label)}
                />
              )}
            </For>
          </ul>
        ) : (
          <p class="routines-empty">{shareBusy() ? "Loading shared media…" : "No media shared."}</p>
        )}
      </section>

      <section class="routines-info-section" aria-labelledby="routine-info-files">
        <h3 id="routine-info-files">Files</h3>
        {files().length ? (
          <ul class="routines-info-list">
            <For each={files()}>
              {(item) => (
                <li>
                  <button
                    type="button"
                    onClick={() =>
                      item.kind === "attachment"
                        ? vscode.postMessage({
                            type: "routineInboxAttachmentOpen",
                            requestID: crypto.randomUUID(),
                            agentID: props.agentID,
                            attachmentID: item.attachmentID!,
                          })
                        : vscode.postMessage({
                            type: "openFile",
                            filePath: item.path!,
                            ...(item.sessionID ? { sessionID: item.sessionID } : {}),
                          })
                    }
                  >
                    <strong>{item.label}</strong>
                    <span>{item.kind === "attachment" ? `${item.mime} · ${bytes(item.size!)}` : item.path}</span>
                    <span>{stamp(item.time)}</span>
                  </button>
                  <div class="routines-info-item-actions">
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={!props.connected}
                      onClick={() => props.onLocate(item.messageID, item.label)}
                    >
                      Show in conversation
                    </Button>
                  </div>
                </li>
              )}
            </For>
          </ul>
        ) : (
          <p class="routines-empty">{shareBusy() ? "Loading shared files…" : "No files shared."}</p>
        )}
      </section>

      <section class="routines-info-section" aria-labelledby="routine-info-links">
        <h3 id="routine-info-links">Links</h3>
        {links().length ? (
          <ul class="routines-info-list">
            <For each={links()}>
              {(item) => (
                <li>
                  <button type="button" onClick={() => vscode.postMessage({ type: "openExternal", url: item.url! })}>
                    <strong>{item.label}</strong>
                    <span>{item.url}</span>
                    <span>{stamp(item.time)}</span>
                  </button>
                  <div class="routines-info-item-actions">
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={!props.connected}
                      onClick={() => props.onLocate(item.messageID, item.label)}
                    >
                      Show in conversation
                    </Button>
                  </div>
                </li>
              )}
            </For>
          </ul>
        ) : (
          <p class="routines-empty">{shareBusy() ? "Loading shared links…" : "No links shared."}</p>
        )}
        {shareError() ? (
          <p class="routines-error" role="alert">
            {shareError()}
          </p>
        ) : null}
        {shareError() ? (
          <Button size="small" variant="ghost" onClick={() => load("shares", after.shares)}>
            Retry shared items
          </Button>
        ) : null}
        {shareNext() ? (
          <Button size="small" variant="ghost" disabled={shareBusy()} onClick={() => load("shares", shareNext())}>
            Load more shared items
          </Button>
        ) : null}
      </section>

      <section class="routines-info-section" aria-labelledby="routine-info-contacts">
        <h3 id="routine-info-contacts">Worker communication</h3>
        {contacts().length ? (
          <ul class="routines-info-list routines-info-contacts">
            <For each={contacts()}>
              {(item) => (
                <li>
                  <div class="routines-info-contact">
                    <strong>{item.name}</strong>
                    <span>
                      {item.direction === "sent" ? "Asked" : "Received"} · {item.role}
                      {item.archived ? " · Archived" : ""}
                    </span>
                    <div class="routines-info-exchange">
                      <span class="routines-line-meta">
                        {item.state} · {stamp(item.updated)}
                      </span>
                      {item.organizationName ? (
                        <span class="routines-line-meta">
                          {item.organizationName} · organization revision {item.organizationRevision}
                        </span>
                      ) : null}
                      <p>{item.objective}</p>
                      {item.expected ? <p>Expected: {item.expected}</p> : null}
                      {item.context ? <p>Shared context: {item.context}</p> : null}
                      {item.response ? <p>{item.response}</p> : null}
                      {item.reason ? <p class="routines-error">{item.reason}</p> : null}
                      {typeof item.cost === "number" ? <p>Recorded child cost: ${item.cost}</p> : null}
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={!props.connected}
                        onClick={() => props.onTrace(item.delegationID, item.name)}
                      >
                        View request chain
                      </Button>
                    </div>
                  </div>
                </li>
              )}
            </For>
          </ul>
        ) : (
          <p class="routines-empty">
            {contactBusy() ? "Loading worker communication…" : "No worker conversations yet."}
          </p>
        )}
        {contactError() ? (
          <p class="routines-error" role="alert">
            {contactError()}
          </p>
        ) : null}
        {contactError() ? (
          <Button size="small" variant="ghost" onClick={() => load("contacts", after.contacts)}>
            Retry worker communication
          </Button>
        ) : null}
        {contactNext() ? (
          <Button size="small" variant="ghost" disabled={contactBusy()} onClick={() => load("contacts", contactNext())}>
            Load more communication
          </Button>
        ) : null}
      </section>
    </div>
  )
}
