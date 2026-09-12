import { Component, For, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { useVSCode } from "../../context/vscode"
import type { ExtensionMessage } from "../../types/messages"

type Share = {
  kind: "file" | "link"
  messageID: string
  label: string
  time: number
  path?: string
  url?: string
  sessionID?: string
}

type Contact = {
  peerID: string
  name: string
  role: string
  archived: boolean
  direction: "sent" | "received"
  delegationID: string
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
  if (row.kind !== "file" && row.kind !== "link") return false
  if (typeof row.messageID !== "string" || typeof row.label !== "string" || !finite(row.time)) return false
  if (row.sessionID !== undefined && typeof row.sessionID !== "string") return false
  if (row.kind === "file") return typeof row.path === "string"
  return typeof row.url === "string" && /^https?:\/\//i.test(row.url)
}

function optionalText(row: Record<string, unknown>, keys: string[]) {
  return keys.every((key) => row[key] === undefined || typeof row[key] === "string")
}

function validContact(value: unknown): value is Contact {
  if (!value || typeof value !== "object") return false
  const row = value as Record<string, unknown>
  if (!optionalText(row, ["expected", "context", "response", "reason"])) return false
  if (row.cost !== undefined && (typeof row.cost !== "number" || !Number.isFinite(row.cost))) return false
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
  onEdit: () => void
  onAccess: () => void
  onOutput: () => void
  onInspect: () => void
  onToggle: () => void
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

  const files = createMemo(() => shares().filter((item) => item.kind === "file"))
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
                      vscode.postMessage({
                        type: "openFile",
                        filePath: item.path!,
                        ...(item.sessionID ? { sessionID: item.sessionID } : {}),
                      })
                    }
                  >
                    <strong>{item.label}</strong>
                    <span>{item.path}</span>
                    <span>{stamp(item.time)}</span>
                  </button>
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
                      <p>{item.objective}</p>
                      {item.expected ? <p>Expected: {item.expected}</p> : null}
                      {item.context ? <p>Shared context: {item.context}</p> : null}
                      {item.response ? <p>{item.response}</p> : null}
                      {item.reason ? <p class="routines-error">{item.reason}</p> : null}
                      {typeof item.cost === "number" ? <p>Recorded child cost: ${item.cost}</p> : null}
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
