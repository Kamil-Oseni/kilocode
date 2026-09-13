// raya_change - preview mock for the VS Code webview API so components render
// without an extension host or a running backend.
import type { VSCodeAPI, WebviewMessage } from "../src/types/messages"

const emit = (data: object) => window.dispatchEvent(new MessageEvent("message", { data }))

const books = {
  id: "routine",
  name: "Books",
  role: "accountant",
  objective: "Review accounts",
  capabilities: ["accounting"],
  schedule: { kind: "manual" },
  enabled: true,
  access: "brief",
}

const legal = {
  id: "legal",
  name: "Counsel",
  role: "counsel",
  objective: "Review contracts",
  capabilities: ["legal", "organization:provision"],
  provisioning: { enabled: true, source: "user" as const, changedAt: 2 },
  schedule: { kind: "manual" },
  enabled: true,
  access: "brief",
}

const report = {
  id: "rmg_1",
  agentID: books.id,
  kind: "report",
  source: "report:occ1",
  body: `Friday expenses increased in travel. ${"receipts/Q3-close/vendor-travel-".repeat(18)}ledger.pdf`,
  files: [{ name: "vendor-travel-ledger-q3-close-final.pdf", path: "receipts/Q3-close/vendor-travel-ledger.pdf" }],
  attachments: [
    {
      id: "123e4567-e89b-42d3-a456-426614174001",
      name: "travel-receipt.png",
      mime: "image/png",
      size: 68,
    },
    {
      id: "123e4567-e89b-42d3-a456-426614174000",
      name: "receipt.pdf",
      mime: "application/pdf",
      size: 42_240,
    },
    {
      id: "123e4567-e89b-42d3-a456-426614174002",
      name: "finance-update.wav",
      mime: "audio/wav",
      size: 44,
    },
  ],
  time: 1,
}

const scene = new URLSearchParams(window.location.search).get("scene") ?? "ready"
let stopped = false
let assignment:
  | {
      source: string
      senderID: string
      recipientID: string
      organizationID: string
      organizationRevision?: number
      objective: string
      expected?: string
      context?: string
      deadline?: number
      budget?: number
    }
  | undefined

const work = (organizationID: string) => {
  const items = [
    {
      id: "rdg_org_preview",
      sender: { id: legal.id, name: legal.name, role: "Chief of Staff", archived: false },
      recipient: { id: books.id, name: books.name, role: "Accounting", archived: false },
      organizationID,
      organizationName: "Website Builders",
      organizationRevision: 1,
      source: "org_preview",
      state: "completed" as const,
      objective: "Review Friday travel expenses and return a reconciled ledger.",
      response: "The ledger is reconciled and the receipt exception is documented.",
      time: 1,
      updated: 3,
      cost: 0.42,
    },
    {
      id: "rdg_org_follow",
      sender: { id: books.id, name: books.name, role: "Accounting", archived: false },
      recipient: { id: legal.id, name: legal.name, role: "Chief of Staff", archived: false },
      organizationID,
      organizationName: "Website Builders",
      organizationRevision: 1,
      source: "org_follow",
      state: (stopped ? "cancelled" : "running") as "cancelled" | "running",
      parentID: "rdg_org_preview",
      objective: "Ask Counsel to approve the documented receipt exception.",
      time: 2,
      updated: stopped ? 4 : 3,
    },
  ]
  if (!assignment) return items
  return [
    ...items,
    {
      id: "rdg_org_assigned",
      sender: { id: legal.id, name: legal.name, role: "Chief of Staff", archived: false },
      recipient: { id: books.id, name: books.name, role: "Accounting", archived: false },
      organizationID,
      organizationName: "Website Builders",
      organizationRevision: 1,
      source: assignment.source,
      state: "running" as const,
      objective: assignment.objective,
      expected: assignment.expected,
      context: assignment.context,
      deadline: assignment.deadline,
      budget: assignment.budget,
      time: 4,
      updated: 4,
    },
  ]
}

const calendar = (message: WebviewMessage) => {
  if (message.type === "routineForecast") {
    const schedule = message.schedule
    if (!schedule) {
      emit({ type: "routineForecast", requestID: message.requestID, error: "Choose a valid schedule." })
      return true
    }
    const base = Date.parse("2030-01-07T14:00:00Z")
    emit({
      type: "routineForecast",
      requestID: message.requestID,
      forecastID: "preview-schedule",
      schedule,
      occurrences: schedule.kind === "cron" ? [base, base + 4 * 86_400_000, base + 7 * 86_400_000] : [],
      timezone: schedule.kind === "cron" ? schedule.tz : undefined,
    })
    return true
  }
  if (message.type !== "routineScheduleUpdate") return false
  emit({ type: "routineScheduleUpdated", requestID: message.requestID, agentID: message.agentID })
  return true
}

const preview = (message: WebviewMessage) => {
  if (message.type === "routineInboxAttachmentPreview") {
    const sound = message.attachmentID === "123e4567-e89b-42d3-a456-426614174002"
    emit({
      type: "routineInboxAttachmentPreviewed",
      requestID: message.requestID,
      agentID: message.agentID,
      file: {
        id: message.attachmentID,
        name: sound ? "finance-update.wav" : "travel-receipt.png",
        mime: sound ? "audio/wav" : "image/png",
        size: sound ? 44 : 68,
        data: sound
          ? "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA="
          : "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      },
    })
    return true
  }
  if (message.type === "routineOrganizationActivity") {
    emit({
      type: "routineOrganizationActivity",
      requestID: message.requestID,
      organizationID: message.organizationID,
      items: work(message.organizationID),
    })
    return true
  }
  if (message.type === "routineDelegateChain") {
    const org = "org_11111111111111111111111111111111"
    const rows = work(org)
    const current = rows.find((item) => item.id === message.id)
    if (!current) return false
    const record = {
      ...current,
      senderID: current.sender.id,
      recipientID: current.recipient.id,
    }
    const root = rows[0]!
    const child = rows[1]!
    const prior = { ...root, senderID: root.sender.id, recipientID: root.recipient.id }
    const follow = { ...child, senderID: child.sender.id, recipientID: child.recipient.id }
    emit({
      type: "routineDelegateChain",
      requestID: message.requestID,
      agentID: message.agentID,
      id: message.id,
      record,
      above: message.id === child.id ? [prior] : [],
      below: message.id === root.id ? [follow] : [],
    })
    return true
  }
  if (message.type === "routineDelegate" && message.organizationID) {
    assignment = {
      source: message.source,
      senderID: message.agentID,
      recipientID: message.recipientID,
      organizationID: message.organizationID,
      organizationRevision: message.organizationRevision,
      objective: message.objective,
      expected: message.expected,
      context: message.context,
      deadline: message.deadline,
      budget: message.budget,
    }
    emit({
      type: "routineDelegated",
      requestID: message.requestID,
      agentID: message.agentID,
      record: {
        id: "rdg_org_assigned",
        source: message.source,
        senderID: message.agentID,
        recipientID: message.recipientID,
        organizationID: message.organizationID,
        organizationName: "Website Builders",
        organizationRevision: message.organizationRevision,
        objective: message.objective,
        expected: message.expected,
        context: message.context,
        deadline: message.deadline,
        budget: message.budget,
        depth: 1,
        state: "running",
        time: 4,
      },
    })
    return true
  }
  if (message.type !== "routineDelegateCancel" || message.id !== "rdg_org_follow") return false
  stopped = true
  const item = work("org_11111111111111111111111111111111")[1]!
  emit({
    type: "routineDelegateStopped",
    requestID: message.requestID,
    agentID: message.agentID,
    record: { ...item, senderID: item.sender.id, recipientID: item.recipient.id },
  })
  return true
}

const reply = (message: WebviewMessage) => {
  if (message.type === "webviewReady") {
    emit({
      type: "ready",
      serverInfo: { port: 0, version: "preview" },
      workspaceDirectory: "C:/Projects/preview",
    })
    return
  }
  if (message.type === "requestProjectUsage") {
    emit({
      type: "projectUsageLoaded",
      requestID: message.requestID,
      data: {
        range: message.range,
        since: Date.now() - 7 * 86_400_000,
        until: Date.now(),
        timezone: "UTC",
        sessions: 18,
        totals: {
          steps: 94,
          cost: 12.4831,
          tokens: {
            input: 824_500,
            output: 126_800,
            reasoning: 41_200,
            cache: { read: 1_420_000, write: 88_000 },
          },
        },
        models: [
          {
            providerID: "openai",
            modelID: "gpt-5.3-codex",
            steps: 51,
            cost: 8.992,
            tokens: {
              input: 430_000,
              output: 76_000,
              reasoning: 31_000,
              cache: { read: 910_000, write: 48_000 },
            },
          },
          {
            providerID: "qwen",
            modelID: "qwen3.8-max",
            steps: 43,
            cost: 3.4911,
            tokens: {
              input: 394_500,
              output: 50_800,
              reasoning: 10_200,
              cache: { read: 510_000, write: 40_000 },
            },
          },
        ],
      },
    })
    return
  }
  if (message.type === "routineList") {
    const id = message.requestID
    const view = message.viewID
    if (scene === "loading") {
      emit({ type: "routineState", requestID: id, viewID: view, refreshID: 1, refresh: "loading" })
      return
    }
    if (scene === "error") {
      emit({
        type: "routineState",
        requestID: id,
        viewID: view,
        refreshID: 1,
        refresh: "error",
        error: "The routine list could not be refreshed. Try Refresh routines.",
      })
      return
    }
    if (scene === "empty") {
      emit({ type: "routineState", requestID: id, viewID: view, refreshID: 1, agents: [], templates: [] })
      emit({ type: "routineInbox", requestID: id, viewID: view, refreshID: 1, items: [] })
      emit({ type: "routineState", requestID: id, viewID: view, refreshID: 1, refresh: "complete" })
      return
    }
    emit({
      type: "routineState",
      requestID: id,
      viewID: view,
      refreshID: 1,
      agents: [books, legal],
      templates: [],
      organizations: [
        {
          version: 1,
          id: "org_11111111111111111111111111111111",
          name: "Website Builders",
          purpose: "Find, design, build, and support better client websites.",
          revision: 1,
          archived: false,
          createdAt: 1,
          updatedAt: 2,
          members: [
            { agentID: legal.id, role: "Chief of Staff", position: 0 },
            { agentID: books.id, role: "Accounting", supervisorID: legal.id, position: 1 },
          ],
          delegations: [{ senderID: legal.id, recipientID: books.id, position: 0 }],
        },
        {
          version: 1,
          id: "org_22222222222222222222222222222222",
          name: "Finance",
          purpose: "Keep the books current and report exceptions.",
          revision: 1,
          archived: false,
          createdAt: 1,
          updatedAt: 1,
          members: [{ agentID: books.id, role: "Accountant", position: 0 }],
          delegations: [],
        },
      ],
    })
    emit({
      type: "routineInbox",
      requestID: id,
      viewID: view,
      refreshID: 1,
      items: [
        {
          agentID: books.id,
          conversationID: "rcv_1",
          name: books.name,
          role: books.role,
          latest: report,
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
            time: 2,
          },
          unread: 1,
          state: "scheduled",
        },
      ],
    })
    if (scene === "stale") {
      emit({
        type: "routineRuns",
        requestID: id,
        agentID: books.id,
        error: "Recorded history could not be refreshed.",
      })
    }
    emit({
      type: "routineState",
      requestID: id,
      viewID: view,
      refreshID: 1,
      refresh: "complete",
    })
    return
  }
  if (message.type === "routineInboxPage") {
    emit({
      type: "routineInboxPage",
      requestID: message.requestID,
      agentID: message.agentID,
      messages: message.agentID === legal.id ? [] : [report],
    })
    return
  }
  if (preview(message)) return
  if (message.type === "routineInboxInfo") {
    emit({
      type: "routineInboxInfo",
      requestID: message.requestID,
      agentID: message.agentID,
      section: message.section,
      items:
        message.section === "shares"
          ? [
              {
                kind: "file",
                messageID: report.id,
                label: report.files[0].name,
                path: report.files[0].path,
                sessionID: "session_preview",
                time: report.time,
              },
              {
                kind: "link",
                messageID: "rmg_link",
                label: "stripe.com",
                url: "https://stripe.com/docs/reports",
                time: 2,
              },
              {
                kind: "attachment",
                attachmentID: report.attachments[1].id,
                messageID: report.id,
                label: report.attachments[1].name,
                mime: report.attachments[1].mime,
                size: report.attachments[1].size,
                time: report.time,
              },
              {
                kind: "attachment",
                attachmentID: report.attachments[0].id,
                messageID: report.id,
                label: report.attachments[0].name,
                mime: report.attachments[0].mime,
                size: report.attachments[0].size,
                time: report.time,
              },
              {
                kind: "attachment",
                attachmentID: report.attachments[2].id,
                messageID: report.id,
                label: report.attachments[2].name,
                mime: report.attachments[2].mime,
                size: report.attachments[2].size,
                time: report.time,
              },
            ]
          : [
              {
                peerID: legal.id,
                name: legal.name,
                role: legal.role,
                archived: false,
                direction: "sent",
                delegationID: "rdg_preview",
                organizationID: "org_11111111111111111111111111111111",
                organizationName: "Website Builders",
                organizationRevision: 1,
                state: "completed",
                objective: "Confirm the vendor contract allows the travel reimbursement.",
                expected: "A cited approval or exception.",
                response: "The policy permits reimbursement with the attached receipt.",
                updated: 3,
              },
            ],
    })
    return
  }
  if (calendar(message)) return
  if (message.type === "routineProvisioningUpdate") {
    legal.capabilities = message.enabled ? ["legal", "organization:provision"] : ["legal"]
    legal.provisioning = { enabled: message.enabled, source: "user", changedAt: Date.now() }
    emit({
      type: "routineProvisioningUpdated",
      requestID: message.requestID,
      agentID: message.agentID,
      agent: legal,
    })
    return
  }
  if (message.type === "routineOrganizationUpdate") {
    if (scene === "conflict") {
      emit({
        type: "routineOrganizationUpdated",
        requestID: message.requestID,
        organizationID: message.organizationID,
        error: "This organization changed after you opened it.",
        recovery: { kind: "conflict", next: "Review the refreshed team before saving again." },
      })
      return
    }
    emit({
      type: "routineOrganizationUpdated",
      requestID: message.requestID,
      organizationID: message.organizationID,
      organization: {
        version: 1,
        id: message.organizationID,
        name: message.name,
        purpose: message.purpose || undefined,
        revision: message.expectedRevision + 1,
        archived: false,
        createdAt: 1,
        updatedAt: Date.now(),
        members: message.members.map((item, position) => ({ ...item, position })),
        delegations: message.delegations.map((item, position) => ({ ...item, position })),
      },
    })
    return
  }
  if (message.type === "routineOrganizationArchive") {
    emit({
      type: "routineOrganizationArchived",
      requestID: message.requestID,
      organizationID: message.organizationID,
      revision: message.expectedRevision + 1,
    })
  }
}

export function installMockVsCode() {
  const scope = globalThis as unknown as { acquireVsCodeApi?: () => VSCodeAPI; rayaPreviewMocked?: boolean }
  if (scope.rayaPreviewMocked) return
  scope.rayaPreviewMocked = true
  const key = "raya-preview-webview-state"
  scope.acquireVsCodeApi = () => ({
    postMessage: (message) => {
      console.info("[raya preview] mock postMessage", message)
      queueMicrotask(() => reply(message))
    },
    getState: () => {
      const value = sessionStorage.getItem(key)
      return value ? JSON.parse(value) : undefined
    },
    setState: (state) => sessionStorage.setItem(key, JSON.stringify(state)),
  })
}
