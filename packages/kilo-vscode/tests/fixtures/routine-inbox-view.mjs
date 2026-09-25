import assert from "node:assert/strict"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { Window } from "happy-dom"

plugin({
  name: "routine-inbox-dom",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
      const result = await transformAsync(await Bun.file(path).text(), {
        filename: path,
        configFile: false,
        babelrc: false,
        presets: [
          [import.meta.resolve("babel-preset-solid"), { generate: "dom" }],
          import.meta.resolve("@babel/preset-typescript"),
        ],
      })
      if (!result?.code) throw new Error("No compiled component")
      return { contents: result.code, loader: "js" }
    })
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "export default {}", loader: "js" }))
    build.onLoad({ filter: /\?worker&url$/ }, () => ({ contents: "export default 'test-worker.js'", loader: "js" }))
  },
})
const window = new Window()
for (const name of [
  "document",
  "navigator",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLHeadElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "HTMLTextAreaElement",
  "MutationObserver",
  "ResizeObserver",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "MessageEvent",
  "CustomEvent",
])
  globalThis[name] = window[name]
globalThis.window = window
globalThis.getComputedStyle = window.getComputedStyle.bind(window)
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
const sent = []
let webview = { unrelated: "keep me" }
globalThis.acquireVsCodeApi = () => ({
  postMessage: (msg) => sent.push(msg),
  getState: () => webview,
  setState: (state) => {
    webview = state
  },
})
const { createComponent } = await import("solid-js")
const { render } = await import("solid-js/web")
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode.tsx")
const { LanguageContext } = await import("../../webview-ui/src/context/language.tsx")
const { SessionContext } = await import("../../webview-ui/src/context/session.tsx")
const { DialogProvider } = await import("@kilocode/kilo-ui/context/dialog")
const { default: RoutinesView } = await import("../../webview-ui/src/components/routines/RoutinesView.tsx")
const { status } = await import("../../webview-ui/src/components/routines/Inbox.tsx")
const root = document.createElement("div")
document.body.append(root)
const mount = (workspace = "C:/Projects/Books") =>
  render(
    () =>
      createComponent(VSCodeProvider, {
        get children() {
          return createComponent(LanguageContext.Provider, {
            value: { locale: () => "en", setLocale: () => {}, userOverride: () => "", t: (key) => key },
            get children() {
              return createComponent(SessionContext.Provider, {
                value: { agents: () => [] },
                get children() {
                  return createComponent(DialogProvider, {
                    get children() {
                      return createComponent(RoutinesView, { workspace })
                    },
                  })
                },
              })
            },
          })
        },
      }),
    root,
  )
let dispose = mount()
const emit = (data) => window.dispatchEvent(new window.MessageEvent("message", { data }))
const button = (text) => {
  const found = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === text)
  assert.ok(found, `Missing button: ${text}`)
  return found
}
try {
  await new Promise((resolve) => setImmediate(resolve))
  const request = sent.find((msg) => msg.type === "routineList")
  const agent = {
    id: "routine",
    name: "Books",
    role: "accountant",
    objective: "Review accounts",
    capabilities: ["accounting"],
    schedule: { kind: "manual" },
    enabled: true,
    access: "brief",
  }
  const organization = {
    version: 1,
    id: `org_${"a".repeat(32)}`,
    name: "Acceptance Team",
    purpose: "Verify durable organization behavior.",
    revision: 1,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    members: [{ agentID: agent.id, role: "Persistence verifier", position: 0 }],
    delegations: [],
  }
  const note = {
    id: "rmg_1",
    agentID: agent.id,
    kind: "report",
    source: "report:occ1",
    body: "Friday expenses increased in travel.",
    files: [{ name: "ledger.pdf", path: "receipts/Q3-close/ledger.pdf" }],
    time: 1,
  }
  const legacy = {
    id: "rmg_legacy",
    agentID: agent.id,
    kind: "report",
    source: "report:legacy",
    body: [
      "Run blocked (2026-09-21T04:12:47.532Z).",
      "Conversational reply delivered, but this objective is a pure conversation response with no eligible tool-call work evidence to cite, so the completion audit cannot be satisfied.",
      "This is not a completed report.",
    ].join("\n"),
    time: 1.5,
  }
  const delegation = {
    id: "rmg_delegation",
    agentID: agent.id,
    kind: "delegation",
    source: "sent:legacy-request",
    body: [
      "Asked Counsel:",
      "Acceptance Team · organization revision 2",
      "Confirm that the saved organization can be read back intact.",
      "This request is queued until the worker is free. It has not started.",
    ].join("\n"),
    occurrenceID: "dlg_1",
    time: 1.75,
  }
  emit({
    type: "routineState",
    requestID: request.requestID,
    viewID: request.viewID,
    refreshID: 1,
    agents: [agent],
    organizations: [organization],
    templates: [],
  })
  emit({
    type: "routineInbox",
    requestID: request.requestID,
    viewID: request.viewID,
    refreshID: 1,
    items: [
      {
        agentID: agent.id,
        conversationID: "rcv_1",
        name: agent.name,
        role: agent.role,
        latest: note,
        unread: 1,
        state: "scheduled",
      },
    ],
  })
  emit({
    type: "routineState",
    requestID: request.requestID,
    viewID: request.viewID,
    refreshID: 1,
    refresh: "complete",
  })
  assert.match(root.textContent, /Friday expenses increased in travel/)
  assert.equal(root.querySelector(".routines-unread").getAttribute("aria-label"), "1 unread")
  assert.match(root.querySelector(".routines-identity").getAttribute("aria-label"), /Ready/)
  assert.equal(status("scheduled", false), "Scheduled")
  assert.equal(status("failed", true), "Failed")
  assert.equal(status("scheduled", true, false), "Paused")
  assert.equal(status("running", true, false), "Running")
  assert.ok(root.querySelector(".routines-main-header"))
  assert.ok(root.querySelector(".routines-roster-search"))
  const options = [...root.querySelectorAll("summary")].find((item) => item.textContent.trim() === "More options")
  options.click()
  button("Report settings").click()
  await new Promise((resolve) => setImmediate(resolve))
  const globalReports = sent.find((msg) => msg.type === "routineContactDestination" && msg.global === true)
  assert.ok(globalReports)
  assert.equal(globalReports.agentID, undefined)
  assert.equal(globalReports.organizationID, undefined)
  emit({
    type: "routineContactDestination",
    requestID: globalReports.requestID,
    global: true,
    enabled: false,
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(document.body.textContent, /Allow any eligible Routine worker to report to its own conversation/)
  button("Done").click()
  root.querySelector(".routines-identity").click()
  assert.equal(webview.unrelated, "keep me")
  assert.deepEqual(Object.values(webview.routineInbox.selected), [agent.id])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(root.querySelector(".routines-thread-avatar").textContent.trim(), "B")
  assert.match(root.querySelector(".routines-thread-head .routines-meta").textContent, /Ready/)
  assert.ok(root.querySelector(".routines-composer"))
  root.querySelector('[data-routine-organization="org_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]').click()
  assert.equal(root.querySelector(".routines-thread[role='region']"), null)
  assert.match(
    root.querySelector(".routines-organization-overview").textContent,
    /Verify durable organization behavior/,
  )
  button("Settings").click()
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(root.querySelector(".routines-organization-editor h3").textContent, /Team settings/)
  assert.doesNotMatch(root.querySelector(".routines-organization-editor").textContent, /Revision \d+/)
  const settings = [...root.querySelectorAll(".routines-organization-disclosure")]
  assert.equal(settings.length, 3)
  assert.ok(settings.every((item) => !item.open))
  const workerSettings = root.querySelector(".routines-organization-member-settings")
  assert.equal(workerSettings.open, false)
  workerSettings.querySelector("summary").click()
  assert.equal(workerSettings.open, true)
  button("Cancel").click()
  await new Promise((resolve) => setImmediate(resolve))
  root.querySelector(".routines-identity").click()
  await new Promise((resolve) => setImmediate(resolve))
  const page = sent.findLast((msg) => msg.type === "routineInboxPage")
  assert.equal(page.agentID, agent.id)
  emit({
    type: "routineInboxPage",
    requestID: page.requestID,
    agentID: agent.id,
    messages: [note, legacy, delegation],
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(root.textContent, /Report/)
  assert.match(root.textContent, /The reply was delivered\. This scheduled run still needs review\./)
  assert.doesNotMatch(root.textContent, /completion audit cannot be satisfied|This is not a completed report/)
  const requestDetails = root.querySelector('[data-routine-message="rmg_delegation"] .routines-line-actions')
  const requestCard = requestDetails.closest("article")
  assert.equal(requestDetails.open, false)
  assert.match(requestCard.querySelector(".routines-line-meta").textContent, /To Counsel/)
  assert.equal(requestCard.querySelector(".routines-line-context").textContent, "Acceptance Team")
  assert.equal(
    requestCard.querySelector(".routines-line-body").textContent,
    "Confirm that the saved organization can be read back intact.",
  )
  assert.equal(requestCard.querySelector(".routines-line-status").textContent, "Waiting to start")
  assert.doesNotMatch(requestCard.textContent, /organization revision|queued until/)
  assert.doesNotMatch(root.textContent, /Does not change the assignment/)
  const card = root.querySelector('[aria-label="Open ledger.pdf"]')
  assert.ok(card)
  assert.equal(card.querySelector(".routines-file-name").textContent, "ledger.pdf")
  card.click()
  const opened = sent.findLast((msg) => msg.type === "openFile")
  assert.equal(opened.filePath, "receipts/Q3-close/ledger.pdf")
  const area = root.querySelector("textarea[aria-label='Message this worker']")
  area.focus()
  area.value = "Why did expenses increase?"
  area.dispatchEvent(new window.Event("input", { bubbles: true }))
  const refreshes = sent.filter((msg) => msg.type === "routineList").length
  const pagesBeforeRefresh = sent.filter((msg) => msg.type === "routineInboxPage").length
  for (let i = 0; i < 100; i++)
    emit({ type: "sessionStatus", sessionID: `streaming-session-${i}`, status: { type: "busy" } })
  assert.equal(sent.filter((msg) => msg.type === "routineInboxPage").length, pagesBeforeRefresh)
  assert.equal(document.activeElement, area)
  assert.equal(area.value, "Why did expenses increase?")
  emit({ type: "sessionTurnClosed", sessionID: "unrelated-session" })
  assert.equal(sent.filter((msg) => msg.type === "routineList").length, refreshes)
  assert.equal(sent.filter((msg) => msg.type === "routineInboxPage").length, pagesBeforeRefresh + 1)
  assert.equal(document.activeElement, area)
  assert.equal(area.value, "Why did expenses increase?")
  const typingPage = sent.findLast((msg) => msg.type === "routineInboxPage")
  emit({ type: "routineInboxPage", requestID: typingPage.requestID, agentID: agent.id, messages: [note] })
  emit({
    type: "routineInbox",
    requestID: request.requestID,
    viewID: request.viewID,
    refreshID: 1,
    items: [
      {
        agentID: agent.id,
        conversationID: "rcv_1",
        name: agent.name,
        role: agent.role,
        latest: { ...note, id: "rmg_2", body: "A later report arrived." },
        unread: 2,
        state: "scheduled",
      },
    ],
  })
  assert.equal(document.activeElement, area)
  assert.equal(area.value, "Why did expenses increase?")
  button("Attach").click()
  const pick = sent.findLast((msg) => msg.type === "routineInboxFilesPick")
  assert.equal(pick.agentID, agent.id)
  assert.equal(pick.draft, "Why did expenses increase?")
  assert.doesNotMatch(JSON.stringify(pick), /data:|filePath|AQID/)
  assert.match(root.textContent, /Saving attachment/)
  const attachment = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    name: "receipt.pdf",
    mime: "application/pdf",
    size: 3,
  }
  emit({
    type: "routineInboxFiles",
    requestID: pick.requestID,
    agentID: agent.id,
    draft: pick.draft,
    files: [attachment],
    revision: pick.revision,
  })
  assert.match(root.textContent, /receipt.pdf/)
  button("Send").click()
  const first = sent.findLast((msg) => msg.type === "routineInboxSend")
  assert.equal(first.body, "Why did expenses increase?")
  assert.deepEqual(first.attachmentIDs, [attachment.id])
  emit({
    type: "routineInboxSent",
    requestID: first.requestID,
    agentID: agent.id,
    error: "Could not save that follow-up.",
  })
  assert.match(root.textContent, /Could not save that follow-up/)
  button("Retry").click()
  const retry = sent.findLast((msg) => msg.type === "routineInboxSend")
  assert.equal(retry.source, first.source)
  assert.equal(retry.body, first.body)
  assert.deepEqual(retry.attachmentIDs, first.attachmentIDs)
  assert.match(root.textContent, /receipt.pdf/)
  emit({
    type: "routineInboxSent",
    requestID: retry.requestID,
    agentID: agent.id,
    message: {
      id: "rmg_user",
      agentID: agent.id,
      kind: "user",
      source: retry.source,
      body: retry.body,
      attachments: [attachment],
      time: 2,
    },
  })
  assert.match(root.textContent, /You/)
  assert.equal(root.querySelector("textarea[aria-label='Message this worker']").value, "")
  assert.match(root.querySelector('[data-routine-message="rmg_user"]').textContent, /receipt.pdf/)
  const keyboard = root.querySelector("textarea[aria-label='Message this worker']")
  keyboard.value = "Send from the keyboard"
  keyboard.dispatchEvent(new window.Event("input", { bubbles: true }))
  const beforeKeys = sent.filter((msg) => msg.type === "routineInboxSend").length
  const newline = new window.KeyboardEvent("keydown", {
    key: "Enter",
    keyCode: 13,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  })
  keyboard.dispatchEvent(newline)
  assert.equal(newline.defaultPrevented, false)
  assert.equal(sent.filter((msg) => msg.type === "routineInboxSend").length, beforeKeys)
  const enter = new window.KeyboardEvent("keydown", {
    key: "Enter",
    keyCode: 13,
    bubbles: true,
    cancelable: true,
  })
  keyboard.dispatchEvent(enter)
  assert.equal(enter.defaultPrevented, true)
  const keyboardSend = sent.findLast((msg) => msg.type === "routineInboxSend")
  assert.equal(keyboardSend.body, "Send from the keyboard")
  emit({
    type: "routineInboxSent",
    requestID: keyboardSend.requestID,
    agentID: agent.id,
    message: {
      id: "rmg_keyboard",
      agentID: agent.id,
      kind: "user",
      source: keyboardSend.source,
      body: keyboardSend.body,
      time: 2.5,
    },
  })
  root.querySelector('[data-routine-message="rmg_user"] [aria-label="Open receipt.pdf"]').click()
  const openedAttachment = sent.findLast((msg) => msg.type === "routineInboxAttachmentOpen")
  assert.equal(openedAttachment.agentID, agent.id)
  assert.equal(openedAttachment.attachmentID, attachment.id)
  emit({
    type: "routineInbox",
    requestID: request.requestID,
    viewID: request.viewID,
    refreshID: 1,
    items: [
      {
        agentID: agent.id,
        conversationID: "rcv_1",
        name: agent.name,
        role: agent.role,
        latest: {
          id: "rmg_3",
          agentID: agent.id,
          kind: "report",
          source: "report:occ2",
          body: "The next Friday close found the travel receipts.",
          time: 3,
        },
        unread: 1,
        state: "scheduled",
      },
    ],
  })
  await new Promise((resolve) => setImmediate(resolve))
  const again = sent.findLast((msg) => msg.type === "routineInboxPage")
  emit({
    type: "routineInboxPage",
    requestID: again.requestID,
    agentID: agent.id,
    next: "older-share",
    messages: [
      note,
      { id: "rmg_user", agentID: agent.id, kind: "user", source: retry.source, body: retry.body, time: 2 },
      {
        id: "rmg_3",
        agentID: agent.id,
        kind: "report",
        source: "report:occ2",
        body: "The next Friday close found the travel receipts.",
        time: 3,
      },
    ],
  })
  assert.match(root.textContent, /Friday expenses increased in travel/)
  assert.match(root.textContent, /Why did expenses increase/)
  assert.match(root.textContent, /The next Friday close found the travel receipts/)
  assert.doesNotMatch(root.textContent, /Does not change the assignment/)
  const thread = root.querySelector(".routines-thread[role='region']")
  assert.equal(thread.getAttribute("aria-label"), "Conversation with Books")
  assert.equal(root.querySelector(".routines-view").getAttribute("data-detail"), "true")
  assert.equal(root.querySelector(".routines-detail-back").textContent.trim(), "Acceptance Team")
  assert.equal(
    root.querySelector(".routines-thread-head [aria-label^='Back to']").getAttribute("aria-label"),
    "Back to Acceptance Team",
  )
  const pane = root.querySelector(".routines-thread-body")
  assert.equal(pane.getAttribute("role"), "log")
  assert.equal(pane.getAttribute("tabindex"), "0")
  assert.equal(pane.getAttribute("aria-label"), "Messages with Books")
  const draft = root.querySelector("textarea[aria-label='Message this worker']")
  draft.focus()
  draft.value = "Keep this draft"
  draft.dispatchEvent(new window.Event("input", { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 450))
  const firstDraft = sent.findLast((msg) => msg.type === "routineInboxDraft")
  draft.value = "Newest draft"
  draft.dispatchEvent(new window.Event("input", { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 450))
  const newestDraft = sent.findLast((msg) => msg.type === "routineInboxDraft")
  assert.ok(newestDraft.revision > firstDraft.revision)
  emit({
    type: "routineInboxDraft",
    requestID: newestDraft.requestID,
    agentID: agent.id,
    draft: newestDraft.draft,
    revision: newestDraft.revision,
  })
  emit({
    type: "routineInboxDraft",
    requestID: firstDraft.requestID,
    agentID: agent.id,
    error: "This draft is older than the version Raya already saved.",
  })
  assert.equal(draft.value, "Newest draft")
  assert.doesNotMatch(root.textContent, /changed in another Raya window/)
  draft.value = "Keep this draft"
  draft.dispatchEvent(new window.Event("input", { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 450))
  const conflictedDraft = sent.findLast((msg) => msg.type === "routineInboxDraft")
  emit({
    type: "routineInboxDraft",
    requestID: conflictedDraft.requestID,
    agentID: agent.id,
    error: "This draft is older than the version Raya already saved.",
    recovery: { kind: "conflict", next: "Reload the current routine and compare it with your draft." },
  })
  assert.equal(draft.value, "Keep this draft")
  assert.match(root.textContent, /changed in another Raya window/)
  const infoToggle = button("Info")
  infoToggle.click()
  assert.equal(infoToggle.getAttribute("aria-expanded"), "true")
  await new Promise((resolve) => setImmediate(resolve))
  const facts = root.querySelector(".routines-info-facts")
  assert.match(facts.textContent, /StatusReady/)
  assert.match(facts.textContent, /ScheduleWhen you ask/)
  const info = sent.filter((msg) => msg.type === "routineInboxInfo" && msg.agentID === agent.id)
  const shares = info.find((msg) => msg.section === "shares")
  const contacts = info.find((msg) => msg.section === "contacts")
  const reports = sent.find((msg) => msg.type === "routineContactDestination" && msg.agentID === agent.id)
  assert.ok(shares)
  assert.ok(contacts)
  assert.ok(reports)
  emit({
    type: "routineContactDestination",
    requestID: reports.requestID,
    agentID: agent.id,
    enabled: true,
  })
  emit({
    type: "routineInboxInfo",
    requestID: shares.requestID,
    agentID: agent.id,
    section: "shares",
    items: [
      {
        kind: "file",
        messageID: note.id,
        label: "ledger.pdf",
        path: "receipts/Q3-close/ledger.pdf",
        messageKind: note.kind,
        source: note.source,
        time: note.time,
      },
      {
        kind: "link",
        messageID: "rmg_link",
        label: "https://example.com/receipt-policy",
        url: "https://example.com/receipt-policy",
        messageKind: "report",
        source: "report:occ2",
        time: 3,
      },
      {
        kind: "attachment",
        attachmentID: attachment.id,
        messageID: "rmg_user",
        label: attachment.name,
        mime: attachment.mime,
        size: attachment.size,
        messageKind: "user",
        source: retry.source,
        time: 2,
      },
    ],
  })
  emit({
    type: "routineInboxInfo",
    requestID: contacts.requestID,
    agentID: agent.id,
    section: "contacts",
    items: [
      {
        peerID: "legal",
        name: "Counsel",
        role: "reviewer",
        archived: false,
        direction: "sent",
        delegationID: "rdl_1",
        source: "dlg:legal",
        state: "completed",
        objective: "Review the travel receipt policy.",
        response: "The exception is documented.",
        time: 3,
        updated: 4,
      },
    ],
  })
  assert.match(root.textContent, /Chat info for Books|About/)
  assert.match(root.textContent, /Reports to you|Stop reports/)
  assert.match(root.textContent, /Set quiet hours/)
  assert.match(root.textContent, /Review the travel receipt policy/)
  const sharedLink = [...root.querySelectorAll(".routines-info-list button")].find((item) =>
    item.textContent.includes("receipt-policy"),
  )
  assert.ok(sharedLink)
  sharedLink.click()
  assert.equal(sent.findLast((msg) => msg.type === "openExternal").url, "https://example.com/receipt-policy")
  const sharedAttachment = [...root.querySelectorAll(".routines-info-list button")].find((item) =>
    item.textContent.includes("receipt.pdf"),
  )
  assert.ok(sharedAttachment)
  sharedAttachment.click()
  assert.equal(sent.findLast((msg) => msg.type === "routineInboxAttachmentOpen").attachmentID, attachment.id)
  assert.equal(draft.value, "Keep this draft")
  infoToggle.click()
  await Promise.resolve()
  assert.equal(infoToggle.getAttribute("aria-expanded"), "false")
  assert.equal(root.querySelector("textarea[aria-label='Message this worker']").value, "Keep this draft")
  infoToggle.click()
  await new Promise((resolve) => setImmediate(resolve))
  const linkRow = sharedLink.closest("li")
  const locate = [...linkRow.querySelectorAll("button")].find((item) =>
    item.textContent.includes("Show in conversation"),
  )
  assert.ok(locate)
  locate.click()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(infoToggle.getAttribute("aria-expanded"), "false")
  const olderShare = sent.findLast((msg) => msg.type === "routineInboxPage")
  assert.equal(olderShare.cursor, "older-share")
  emit({
    type: "routineInboxPage",
    requestID: olderShare.requestID,
    agentID: agent.id,
    messages: [
      {
        id: "rmg_link",
        agentID: agent.id,
        kind: "report",
        source: "report:occ2",
        body: "Read https://example.com/receipt-policy before approving this expense.",
        time: 3,
      },
    ],
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(root.textContent, /Showing where https:\/\/example.com\/receipt-policy was shared/)
  assert.match(root.textContent, /Read https:\/\/example.com\/receipt-policy before approving this expense/)
  assert.equal(root.querySelector("textarea[aria-label='Message this worker']").value, "Keep this draft")
  button("Return to latest").click()
  const returned = sent.findLast((msg) => msg.type === "routineInboxPage")
  emit({
    type: "routineInboxPage",
    requestID: returned.requestID,
    agentID: agent.id,
    next: "older-share",
    messages: [
      note,
      { id: "rmg_user", agentID: agent.id, kind: "user", source: retry.source, body: retry.body, time: 2 },
      {
        id: "rmg_3",
        agentID: agent.id,
        kind: "report",
        source: "report:occ2",
        body: "The next Friday close found the travel receipts.",
        time: 3,
      },
    ],
  })
  await new Promise((resolve) => setImmediate(resolve))
  const legal = {
    id: "legal",
    name: "Counsel",
    role: "counsel",
    objective: "Review contracts",
    capabilities: ["legal"],
    schedule: { kind: "manual" },
    enabled: true,
    access: "brief",
  }
  const pages = sent.filter((msg) => msg.type === "routineInboxPage").length
  const retainedDraft = root.querySelector("textarea[aria-label='Message this worker']")
  retainedDraft.focus()
  emit({
    type: "routineState",
    requestID: request.requestID,
    viewID: request.viewID,
    refreshID: 1,
    agents: [{ ...agent, nextRun: Date.now() + 60_000 }, { ...legal }],
    templates: [],
  })
  emit({
    type: "routineInbox",
    requestID: request.requestID,
    viewID: request.viewID,
    refreshID: 1,
    items: [
      {
        agentID: agent.id,
        conversationID: "rcv_1",
        name: agent.name,
        role: agent.role,
        latest: {
          id: "rmg_3",
          agentID: agent.id,
          kind: "report",
          source: "report:occ2",
          body: "The next Friday close found the travel receipts.",
          time: 3,
        },
        unread: 1,
        state: "scheduled",
      },
      {
        agentID: legal.id,
        conversationID: "rcv_legal",
        name: legal.name,
        role: legal.role,
        latest: {
          id: "rmg_legal",
          agentID: legal.id,
          kind: "report",
          source: "report:legal1",
          body: "Counsel filed the motion.",
          time: 4,
        },
        unread: 1,
        state: "scheduled",
      },
    ],
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(sent.filter((msg) => msg.type === "routineInboxPage").length, pages)
  assert.equal(sent.filter((msg) => msg.type === "routineInboxPage" && msg.agentID === legal.id).length, 0)
  assert.equal(root.querySelector("textarea[aria-label='Message this worker']"), retainedDraft)
  assert.match(root.textContent, /Counsel/)
  assert.equal(
    root.querySelector(".routines-thread[role='region']").getAttribute("aria-label"),
    "Conversation with Books",
  )
  assert.equal(document.activeElement, retainedDraft)
  assert.equal(retainedDraft.value, "Keep this draft")
  assert.doesNotMatch(thread.textContent, /Counsel filed the motion/)
  let top = 40
  Object.defineProperties(pane, {
    scrollHeight: { configurable: true, get: () => 800 },
    clientHeight: { configurable: true, get: () => 200 },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value) => {
        top = value
      },
    },
  })
  pane.getBoundingClientRect = () => ({ top: 0, bottom: 200 })
  const visible = pane.querySelector('[data-routine-message="rmg_user"]')
  visible.getBoundingClientRect = () => ({ top: 20, bottom: 60 })
  for (const row of pane.querySelectorAll("[data-routine-message]")) {
    if (row === visible) continue
    row.getBoundingClientRect = () => ({ top: -80, bottom: -40 })
  }
  pane.dispatchEvent(new window.Event("scroll"))
  assert.deepEqual(
    Object.values(webview.routineInbox.anchors).map(({ id, offset }) => ({ id, offset })),
    [{ id: "rmg_user", offset: 20 }],
  )
  emit({
    type: "routineInbox",
    requestID: request.requestID,
    viewID: request.viewID,
    refreshID: 1,
    items: [
      {
        agentID: agent.id,
        conversationID: "rcv_1",
        name: agent.name,
        role: agent.role,
        latest: {
          id: "rmg_4",
          agentID: agent.id,
          kind: "report",
          source: "report:occ3",
          body: "The later receipt stayed in place.",
          time: 5,
        },
        unread: 2,
        state: "scheduled",
      },
      {
        agentID: legal.id,
        conversationID: "rcv_legal",
        name: legal.name,
        role: legal.role,
        latest: {
          id: "rmg_legal",
          agentID: legal.id,
          kind: "report",
          source: "report:legal1",
          body: "Counsel filed the motion.",
          time: 4,
        },
        unread: 1,
        state: "scheduled",
      },
    ],
  })
  await new Promise((resolve) => setImmediate(resolve))
  const later = sent.findLast((msg) => msg.type === "routineInboxPage")
  emit({
    type: "routineInboxPage",
    requestID: later.requestID,
    agentID: agent.id,
    messages: [
      note,
      { id: "rmg_user", agentID: agent.id, kind: "user", source: retry.source, body: retry.body, time: 2 },
      {
        id: "rmg_3",
        agentID: agent.id,
        kind: "report",
        source: "report:occ2",
        body: "The next Friday close found the travel receipts.",
        time: 3,
      },
      {
        id: "rmg_4",
        agentID: agent.id,
        kind: "report",
        source: "report:occ3",
        body: "The later receipt stayed in place.",
        time: 5,
      },
    ],
  })
  await Promise.resolve()
  assert.equal(pane.scrollTop, 40)
  assert.match(root.textContent, /The later receipt stayed in place/)
  root.querySelector('[aria-label="Back to Acceptance Team"]').click()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(root.querySelector(".routines-thread[role='region']"), null)
  assert.equal(document.activeElement, root.querySelector('[data-routine-worker="routine"]'))
  const saved = sent.findLast((msg) => msg.type === "routineInboxDraft")
  assert.equal(saved.agentID, agent.id)
  assert.equal(saved.draft, "Keep this draft")
  root.querySelector('[data-routine-worker="routine"]').click()
  await new Promise((resolve) => setImmediate(resolve))
  const reopen = sent.findLast((msg) => msg.type === "routineInboxPage")
  emit({
    type: "routineInboxPage",
    requestID: reopen.requestID,
    agentID: agent.id,
    messages: [
      note,
      { id: "rmg_user", agentID: agent.id, kind: "user", source: retry.source, body: retry.body, time: 2 },
      {
        id: "rmg_3",
        agentID: agent.id,
        kind: "report",
        source: "report:occ2",
        body: "The next Friday close found the travel receipts.",
        time: 3,
      },
      {
        id: "rmg_4",
        agentID: agent.id,
        kind: "report",
        source: "report:occ3",
        body: "The later receipt stayed in place.",
        time: 5,
      },
    ],
  })
  const open = root.querySelector(".routines-thread[role='region']")
  assert.equal(open.getAttribute("aria-label"), "Conversation with Books")
  open.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(root.querySelector(".routines-thread[role='region']"), null)
  assert.equal(document.activeElement, root.querySelector('[data-routine-worker="routine"]'))

  webview = {
    ...webview,
    routineInbox: {
      ...webview.routineInbox,
      selected: { ...webview.routineInbox.selected, "c:/projects/books": agent.id },
      anchors: {
        ...webview.routineInbox.anchors,
        '["c:/projects/books","rcv_1"]': { id: "rmg_user", offset: 20, at: Date.now() },
      },
    },
  }
  dispose()
  dispose = mount()
  await new Promise((resolve) => setImmediate(resolve))
  const restored = sent.findLast((msg) => msg.type === "routineList")
  emit({
    type: "routineState",
    requestID: restored.requestID,
    viewID: restored.viewID,
    refreshID: 1,
    agents: [agent, legal],
    templates: [],
  })
  assert.equal(root.querySelector("textarea[aria-label='Message this worker']").disabled, true)
  assert.equal(
    root.querySelector(".routines-thread[role='region']").getAttribute("aria-label"),
    "Conversation with Books",
  )
  emit({
    type: "routineInbox",
    requestID: restored.requestID,
    viewID: restored.viewID,
    refreshID: 1,
    items: [
      {
        agentID: agent.id,
        conversationID: "rcv_1",
        name: agent.name,
        role: agent.role,
        latest: { id: "rmg_4", agentID: agent.id, kind: "report", source: "report:occ3", body: "Latest", time: 5 },
        unread: 1,
        state: "scheduled",
      },
    ],
  })
  assert.equal(root.querySelector("textarea[aria-label='Message this worker']").disabled, false)
  const firstPage = sent.findLast((msg) => msg.type === "routineInboxPage")
  emit({
    type: "routineInboxPage",
    requestID: firstPage.requestID,
    agentID: agent.id,
    messages: [{ id: "rmg_4", agentID: agent.id, kind: "report", source: "report:occ3", body: "Latest", time: 5 }],
    next: "2:rmg_user",
  })
  await new Promise((resolve) => setImmediate(resolve))
  const olderRestore = sent.findLast((msg) => msg.type === "routineInboxPage")
  assert.equal(olderRestore.cursor, "2:rmg_user")
  emit({
    type: "routineInboxPage",
    requestID: olderRestore.requestID,
    agentID: agent.id,
    messages: [
      note,
      { id: "rmg_user", agentID: agent.id, kind: "user", source: retry.source, body: retry.body, time: 2 },
    ],
  })
  const restoredPane = root.querySelector(".routines-thread-body")
  let restoredTop = 0
  Object.defineProperties(restoredPane, {
    scrollHeight: { configurable: true, get: () => 800 },
    clientHeight: { configurable: true, get: () => 200 },
    scrollTop: {
      configurable: true,
      get: () => restoredTop,
      set: (value) => {
        restoredTop = value
      },
    },
  })
  restoredPane.getBoundingClientRect = () => ({ top: 0, bottom: 200 })
  restoredPane.querySelector('[data-routine-message="rmg_user"]').getBoundingClientRect = () => ({
    top: 30,
    bottom: 70,
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(restoredTop, 10)
  assert.equal(webview.unrelated, "keep me")

  dispose()
  webview = {
    ...webview,
    routineInbox: {
      ...webview.routineInbox,
      selected: { ...webview.routineInbox.selected, "c:/projects/legal": "missing" },
    },
  }
  dispose = mount("C:/Projects/Legal")
  await new Promise((resolve) => setImmediate(resolve))
  const isolated = sent.findLast((msg) => msg.type === "routineList")
  emit({
    type: "routineState",
    requestID: isolated.requestID,
    viewID: isolated.viewID,
    refreshID: 1,
    agents: [agent, legal],
    templates: [],
  })
  assert.equal(root.querySelector(".routines-thread[role='region']"), null)
  assert.equal(webview.routineInbox.selected["c:/projects/legal"], undefined)
  assert.equal(webview.routineInbox.selected["c:/projects/books"], agent.id)
  console.log("routine-inbox-view: conversation return and report arrival assertions passed")
} finally {
  dispose()
  root.remove()
  window.happyDOM.abort()
}
