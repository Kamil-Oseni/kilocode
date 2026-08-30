/** @jsxImportSource solid-js */

/**
 * ChatView component
 * Main chat container that combines all chat components
 */

import { type Component, type JSX, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Icon } from "@kilocode/kilo-ui/icon"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { showToast } from "@kilocode/kilo-ui/toast"
import { DropdownMenu } from "@kilocode/kilo-ui/dropdown-menu"
import { TaskHeader } from "./TaskHeader"
import { MessageList } from "./MessageList"
import { PromptInput } from "./PromptInput"
import { PermissionDock } from "./PermissionDock"
import { SessionDock } from "./SessionDock"
import { StartupErrorBanner } from "./StartupErrorBanner"
import { SessionTabStrip } from "./SessionTabStrip"
import { GoalBanner } from "./GoalBanner" // raya_change - Milestone A persistent goal UI
import { useSession } from "../../context/session"
import { useLocalTabs } from "../../context/local-tabs"
import { useVSCode } from "../../context/vscode"
import { useLanguage } from "../../context/language"
import { useWorktreeMode } from "../../context/worktree-mode"
import { useServer } from "../../context/server"
import { TranscriptSearchProvider } from "../../context/transcript-search"
import { isPromptBlocked, isSuggesting, isQuestioning } from "./prompt-input-utils"
import { editReview } from "./edit-review" // raya_change - inline edit review chrome
import { showTabStrip } from "../../utils/local-tabs"

interface ChatViewProps {
  onSelectSession?: (id: string) => void
  onShowHistory?: () => void
  onForkMessage?: (sessionId: string, messageId: string) => void
  onForkSession?: (sessionId: string) => void
  readonly?: boolean
  /** When true, show the "Continue in Worktree" button. Defaults to true in the sidebar. */
  continueInWorktree?: boolean
  promptBoxId?: string
  terminalContext?: () => string | undefined
  deferFocusToQuestion?: () => boolean
  pendingSessionID?: string
  focusOnDraftChange?: () => boolean
  onFocusChange?: (focused: boolean) => void
  emptyState?: () => JSX.Element
  resolveEmbeddedTerminal?: (context?: string) => Promise<string | undefined>
}

export const ChatView: Component<ChatViewProps> = (props) => {
  const session = useSession()
  const vscode = useVSCode()
  const language = useLanguage()
  const worktreeMode = useWorktreeMode()
  const server = useServer()
  const tabs = useLocalTabs()
  // Show "Show Changes" only in the standalone sidebar, not inside Agent Manager
  const isSidebar = () => worktreeMode === undefined
  const pendingSessionID = () => props.pendingSessionID ?? tabs?.pending()

  const id = () => session.currentSessionID()
  // Counts the in-flight first message too, so the dock reserves the same row on
  // the very first send instead of growing once the message lands.
  const hasMessages = () => session.messages().length > 0 || session.submitting()

  // "Continue in Worktree" state
  const [transferring, setTransferring] = createSignal(false)
  const [transferDetail, setTransferDetail] = createSignal("")
  const [repoBranch, setRepoBranch] = createSignal<string>()
  const [kept, setKept] = createSignal<string>()
  const [discarding, setDiscarding] = createSignal(false)
  let worktreeRef: HTMLDivElement | undefined

  // Permissions and questions scoped to this session's family (self + subagents).
  // Each ChatView only sees its own session tree — no cross-session leakage.
  // Memoized so the BFS walk in sessionFamily() runs once per reactive update,
  // not once per accessor call (questionRequest, permissionRequest, blocked all read these).
  const familyPermissions = createMemo(() => session.scopedPermissions(id()))
  const familyQuestions = createMemo(() => session.scopedQuestions(id()))
  const familySuggestions = createMemo(() => session.scopedSuggestions(id()))
  // Non-tool questions (standalone, not from the question tool) render inline in
  // the message list since they don't have an associated tool part in the conversation.
  // Tool-linked questions render inline at their tool part position via AssistantMessage.
  const standaloneQuestions = createMemo(() => familyQuestions().filter((q) => !q.tool))
  const standaloneSuggestions = createMemo(() => familySuggestions().filter((s) => !s.tool))
  const permissionRequest = () => familyPermissions().find((p) => p.sessionID === id()) ?? familyPermissions()[0]
  // Questions and suggestions do not block input; permissions do.
  // Pending questions and suggestions are auto-dismissed in sendMessage/sendCommand.
  const blocked = () => isPromptBlocked(familyPermissions().length)
  // Session is busy only because a suggestion tool call is pending — prompt should behave as idle
  const suggesting = () => isSuggesting(blocked(), familySuggestions().length)
  // Session is busy only because a question tool call is pending — prompt should behave as idle
  const questioning = () => isQuestioning(blocked(), familyQuestions().length)
  const dock = () => !props.readonly || !!permissionRequest() || session.submitting() || session.status() !== "idle"
  // The session dock stays empty while another surface owns the interaction:
  // a permission card, a pending question or suggestion, or agent requirements.
  // A spinner there would claim the agent is working while it waits on the user.
  const dockBlocked = () => blocked() || familyQuestions().length > 0 || familySuggestions().length > 0

  onMount(() => {
    if (props.readonly) return
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || (!session.submitting() && session.status() === "idle") || e.defaultPrevented) return
      e.preventDefault()
      session.abort()
    }
    document.addEventListener("keydown", handler)
    onCleanup(() => document.removeEventListener("keydown", handler))
  })

  // Listen for "Continue in Worktree" progress messages
  {
    const labels: Record<string, string> = {
      capturing: language.t("sidebar.session.progress.capturing"),
      creating: language.t("sidebar.session.progress.creating"),
      setup: language.t("sidebar.session.progress.setup"),
      transferring: language.t("sidebar.session.progress.transferring"),
      forking: language.t("sidebar.session.progress.forking"),
    }
    const cleanup = vscode.onMessage((msg) => {
      if (msg.type === "agentManager.repoInfo") {
        setRepoBranch(msg.branch)
        return
      }
      if (msg.type !== "continueInWorktreeProgress") return
      const m = msg as { status: string; error?: string }
      if (m.status === "done") {
        setTransferring(false)
        setTransferDetail("")
        return
      }
      if (m.status === "error") {
        setTransferring(false)
        setTransferDetail("")
        showToast({ title: m.error ?? language.t("sidebar.session.progress.failed") })
        return
      }
      setTransferDetail(labels[m.status] ?? language.t("session.status.working"))
    })
    onCleanup(cleanup)
  }

  const decide = (response: "once" | "always" | "reject", approvedAlways: string[], deniedAlways: string[]) => {
    const perm = permissionRequest()
    if (!perm || session.respondingPermissions().has(perm.id)) return
    session.respondToPermission(perm.id, response, approvedAlways, deniedAlways)
  }

  const startSession = () => window.dispatchEvent(new CustomEvent("newTaskRequest"))

  const fork = () => {
    const sid = id()
    if (!sid) return
    props.onForkSession?.(sid)
  }

  const startWorktree = () => vscode.postMessage({ type: "agentManager.createWorktree" })

  const startWorktreeFromBranch = () =>
    vscode.postMessage({ type: "agentManager.createWorktree", baseBranch: repoBranch()! })

  const openAgentManager = () => vscode.postMessage({ type: "openAgentManager" })

  const openChanges = () => vscode.postMessage({ type: "openChanges" })

  const stats = createMemo(() => session.reviewStats()) // raya_change - session snapshots, child tasks, then git

  const changeKey = () => {
    const sid = id()
    const next = stats()
    if (!sid || !next?.files) return
    return `${sid}:${next.files}:${next.additions}:${next.deletions}`
  }
  const pending = () => {
    const key = changeKey()
    return !!key && kept() !== key && !session.revert()
  }
  const keepAll = () => {
    const key = changeKey()
    if (key) setKept(key)
    const sid = id()
    if (sid) {
      editReview.keepAll(sid)
      vscode.postMessage({ type: "editReviewKeepAll", sessionID: sid })
    }
    setDiscarding(false)
  }
  const discardAll = () => {
    // raya_change - Undo all discards the session's file edits only; the conversation
    // stays and nothing becomes redoable. (Previously this reverted to the first
    // user message, which wiped the chat and offered a nonsensical redo.)
    const sid = id()
    if (!sid || session.status() !== "idle") return
    // raya_change - retire the Keep all/Undo all cluster immediately, same as keepAll.
    // The backend revert + reviewStats refresh is async, so without pinning kept() the
    // buttons linger after "Confirm undo" until stats happen to drop to zero.
    const key = changeKey()
    if (key) setKept(key)
    vscode.postMessage({ type: "discardSessionChanges", sessionID: sid })
    editReview.keepAll(sid) // raya_change - clear inline review chrome for every edit
    setDiscarding(false)
  }

  const moveToWorktree = () => {
    if (transferring()) return
    const sid = id()
    if (!sid) return
    setTransferring(true)
    setTransferDetail(language.t("sidebar.session.progress.capturing"))
    vscode.postMessage({ type: "continueInWorktree", sessionId: sid })
  }

  const worktreeTooltip = language.t("sidebar.session.newWorktree.tooltip")

  const advancedTooltip = language.t("sidebar.session.configureWorktree.tooltip")

  const moveTooltip = () => {
    const stats = session.worktreeStats()
    if (!stats?.files) return language.t("sidebar.session.moveToWorktree.tooltip.empty")
    if (stats.files === 1) return language.t("sidebar.session.moveToWorktree.tooltip.one")
    return language.t("sidebar.session.moveToWorktree.tooltip.other", { files: stats.files })
  }

  const changesTooltip = () => {
    const next = stats()
    if (!next?.files) return language.t("sidebar.session.showChanges.tooltip.empty")
    return (
      <span class="session-changes-tooltip">
        <span>{next.files === 1 ? "1 file changed" : `${next.files} files changed`}</span>
        <span class="session-changes-tooltip-separator">·</span>
        <span class="session-diff-add">+{next.additions}</span>
        <span class="session-diff-del">-{next.deletions}</span>
        <span>Open the changes view.</span>
      </span>
    )
  }

  const showAdvancedWorktree = () => vscode.postMessage({ type: "openAdvancedWorktree" })

  createEffect(() => {
    if (!isSidebar() || !server.gitInstalled()) return
    vscode.postMessage({ type: "agentManager.requestRepoInfo" })
  })

  createEffect(() => {
    id()
    setDiscarding(false)
    setKept(undefined)
  })

  // A new agent turn can re-edit a file with the same add/del counts; drop the
  // Keep-all pin so Keep all / Undo all come back instead of staying single-use.
  createEffect(() => {
    if (session.status() === "idle") return
    setKept(undefined)
    const sid = id()
    if (sid) editReview.reset(sid)
  })

  onMount(() => {
    const off = vscode.onMessage((message) => {
      if (message.type !== "editReviewSync" || message.sessionID !== id()) return
      editReview.keep(message.sessionID, message.file)
      const left = editReview.pending(message.sessionID)
      if (left.length === 0) {
        const key = changeKey()
        if (key) setKept(key)
      }
    })
    onCleanup(off)
  })

  // raya_change - New session, New worktree, and Move to worktree were bloating
  // the conversation footer. New session already lives in the top bar and the
  // worktree flows live in Agent Manager, so the dock keeps only Review changes /
  // Keep all / Undo all. These predicates stay false to retire that chrome
  // without unwinding the worktree/transfer machinery they were wired to.
  const canStartSession = (_hasChat: boolean) => false

  // Deliberately status-independent: the dock reserves this row's height even
  // while the working indicator covers it, so a button that came and went with
  // the turn would resize the row and shift the transcript. The row is hidden
  // and non-interactive while a turn runs.
  const canFork = (hasChat: boolean) => hasChat && !isSidebar() && !!props.onForkSession

  const canStartWorktree = () => false

  const canMoveToWorktree = (_hasChat: boolean) => false
  const canReviewChanges = (hasChat: boolean) => hasChat // raya_change - snapshot review belongs to every chat, including non-Git folders

  const hasActions = (hasChat: boolean) =>
    canStartSession(hasChat) ||
    canFork(hasChat) ||
    canStartWorktree() ||
    canMoveToWorktree(hasChat) ||
    canReviewChanges(hasChat)

  const renderActions = (hasChat: boolean) => (
    <Show when={hasActions(hasChat)}>
      <div class="new-task-button-wrapper" classList={{ "new-task-button-wrapper--empty": !hasChat }}>
        <div class="session-actions-row">
          <Show when={canStartSession(hasChat)}>
            <Tooltip value={language.t("sidebar.session.newSession.tooltip")} placement="top">
              <Button
                variant="secondary"
                size="small"
                class="session-new-button"
                onClick={startSession}
                aria-label={language.t("sidebar.session.newSession")}
              >
                {language.t("sidebar.session.newSession")}
              </Button>
            </Tooltip>
          </Show>
          <Show when={canFork(hasChat)}>
            <Tooltip value={language.t("agentManager.tab.forkSession")} placement="top">
              <Button
                variant="ghost"
                size="small"
                onClick={fork}
                aria-label={language.t("agentManager.tab.forkSession")}
              >
                <Icon name="fork" size="small" />
                {language.t("agentManager.tab.forkSession")}
              </Button>
            </Tooltip>
          </Show>
          <Show when={canStartWorktree()}>
            <div class="session-worktree-split" ref={worktreeRef}>
              <Tooltip value={worktreeTooltip} placement="top">
                <Button
                  variant="secondary"
                  size="small"
                  class="session-worktree-main"
                  onClick={startWorktree}
                  aria-label={language.t("sidebar.session.newWorktree")}
                >
                  {language.t("sidebar.session.newWorktree")}
                </Button>
              </Tooltip>
              <DropdownMenu gutter={4} placement="top-start" getAnchorRect={() => worktreeRef?.getBoundingClientRect()}>
                <Tooltip value={advancedTooltip} placement="top">
                  <DropdownMenu.Trigger
                    class="session-worktree-split-arrow"
                    aria-label={language.t("agentManager.worktree.advancedOptions")}
                  >
                    <Icon name="chevron-down" size="small" />
                  </DropdownMenu.Trigger>
                </Tooltip>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content class="session-worktree-split-menu">
                    <DropdownMenu.Item disabled={!repoBranch()} onSelect={startWorktreeFromBranch}>
                      <span class="session-worktree-menu-gap" aria-hidden="true" />
                      <DropdownMenu.ItemLabel class="session-worktree-menu-label">
                        <span>{language.t("sidebar.session.newWorktree.from")}</span>
                        <span class="session-worktree-menu-branch">
                          <Icon name="branch" size="small" />
                          <strong>{repoBranch() ?? language.t("sidebar.session.currentBranch")}</strong>
                        </span>
                      </DropdownMenu.ItemLabel>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item onSelect={showAdvancedWorktree}>
                      <Icon name="settings-gear" size="small" />
                      <DropdownMenu.ItemLabel>
                        {language.t("agentManager.dialog.configureWorktree")}
                      </DropdownMenu.ItemLabel>
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu>
            </div>
          </Show>
          <Show when={canMoveToWorktree(hasChat)}>
            <Tooltip value={moveTooltip()} placement="top">
              <Button
                variant="ghost"
                size="small"
                class="session-move-action"
                aria-disabled={transferring()}
                onClick={moveToWorktree}
                aria-label={language.t("sidebar.session.moveToWorktree")}
              >
                <Show when={transferring()} fallback={<Icon name="branch" size="small" />}>
                  <Spinner class="chat-spinner-small" />
                </Show>
                <span class="session-move-label">
                  {transferring() ? transferDetail() : language.t("sidebar.session.moveToWorktree")}
                </span>
              </Button>
            </Tooltip>
          </Show>
          <Show when={canReviewChanges(hasChat)}>
            <div class="session-review-cluster">
            <Tooltip value={changesTooltip()} placement="top" class="session-move-changes-trigger">
              <Button
                variant="ghost"
                size="small"
                class="session-move-changes"
                classList={{
                  "session-move-changes--empty": !stats()?.files,
                  "session-move-changes--has-changes": !!stats()?.files,
                }}
                onClick={openChanges}
                aria-label={language.t("command.session.show.changes")}
              >
                <Icon name="layers" size="small" />
                <span class="session-review-label">Review changes</span>
                <Show when={stats()?.files}>
                  <span class="session-diff-add">+{stats()!.additions}</span>
                  <span class="session-diff-del">-{stats()!.deletions}</span>
                </Show>
              </Button>
            </Tooltip>
            {/* raya_change - Keep all / Undo all only make sense when there are
                unreviewed file edits. pending() already requires changed files
                that haven't been kept or reverted, so a conversation-only turn
                shows neither, and Keep all dismisses the cluster by marking the
                current change set reviewed. */}
            <Show when={pending()}>
            <Show when={!discarding()}>
              <Tooltip value="Keep every file edit in this chat" placement="top">
                <Button
                  variant="ghost"
                  size="small"
                  class="session-move-changes"
                  disabled={session.status() !== "idle"}
                  onClick={keepAll}
                >
                  Keep all
                </Button>
              </Tooltip>
            </Show>
            <Show
              when={discarding()}
              fallback={
                <Tooltip value="Undo every file edit in this chat" placement="top">
                  <Button
                    variant="ghost"
                    size="small"
                    class="session-move-changes"
                    disabled={session.status() !== "idle"}
                    onClick={() => setDiscarding(true)}
                  >
                    Undo all
                  </Button>
                </Tooltip>
              }
            >
              <Tooltip value="This can't be undone" placement="top">
                <Button
                  variant="secondary"
                  size="small"
                  class="session-move-changes session-move-changes--confirm"
                  disabled={session.status() !== "idle"}
                  onClick={discardAll}
                >
                  Confirm undo
                </Button>
              </Tooltip>
              <Button
                variant="ghost"
                size="small"
                class="session-move-changes"
                aria-label="Cancel undo"
                onClick={() => setDiscarding(false)}
              >
                Cancel
              </Button>
            </Show>
            </Show>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  )

  return (
    <TranscriptSearchProvider>
      <div class="chat-view">
        <Show when={isSidebar() && !props.readonly && tabs && showTabStrip(tabs.ids())}>
          <SessionTabStrip />
        </Show>
        <TaskHeader readonly={props.readonly} />
        <Show when={!props.readonly}>
          <GoalBanner /> {/* raya_change - Milestone A persistent goal UI */}
        </Show>
        <div class="chat-messages-wrapper">
          <div class="chat-messages">
            <MessageList
              onSelectSession={props.onSelectSession}
              onShowHistory={props.onShowHistory}
              onForkMessage={props.onForkMessage}
              questions={standaloneQuestions}
              suggestions={standaloneSuggestions}
              readonly={props.readonly}
              emptyState={props.emptyState}
              announce={isSidebar()}
              sessionID={pendingSessionID}
            />
          </div>
        </div>

        <Show when={dock()}>
          <div class="chat-input">
            <Show when={server.connectionState() === "error" && server.errorMessage()}>
              <StartupErrorBanner errorMessage={server.errorMessage()!} errorDetails={server.errorDetails()!} />
            </Show>
            <Show when={permissionRequest()} keyed>
              {(perm) => (
                <PermissionDock
                  request={perm}
                  responding={session.respondingPermissions().has(perm.id)}
                  onDecide={decide}
                />
              )}
            </Show>
            <SessionDock
              blocked={dockBlocked()}
              hasActions={() => !props.readonly && hasActions(hasMessages())}
              actions={() => renderActions(hasMessages())}
            />
            <Show when={!props.readonly}>
              <PromptInput
                blocked={blocked}
                suggesting={suggesting}
                questioning={questioning}
                boxId={props.promptBoxId}
                terminalContext={props.terminalContext}
                deferFocusToQuestion={props.deferFocusToQuestion}
                pendingSessionID={pendingSessionID()}
                focusOnDraftChange={props.focusOnDraftChange}
                onFocusChange={props.onFocusChange}
                resolveEmbeddedTerminal={props.resolveEmbeddedTerminal}
              />
            </Show>
          </div>
        </Show>
      </div>
    </TranscriptSearchProvider>
  )
}
