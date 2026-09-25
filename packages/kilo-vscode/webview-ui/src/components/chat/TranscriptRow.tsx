import { type Component, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { DiffChanges } from "@kilocode/kilo-ui/diff-changes"
import { Icon } from "@kilocode/kilo-ui/icon"
import { useI18n } from "@kilocode/kilo-ui/context/i18n"
import type { AssistantMessage as SDKAssistantMessage, Part as SDKPart, SnapshotFileDiff } from "@kilocode/sdk/v2"
import type { TranscriptRow } from "../../context/transcript-rows"
import type { TimelineHighlight } from "../../utils/timeline/highlight"
import { useSession } from "../../context/session"
import { useServer } from "../../context/server"
import { useLanguage } from "../../context/language"
import { useVSCode } from "../../context/vscode"
import { AssistantMessage } from "./AssistantMessage"
import { ErrorDisplay, type ErrorDisplayProps } from "./ErrorDisplay"
import { MessageTime } from "./MessageTime"
import { MessageTimeline } from "./MessageTimeline"
import { VscodeUserMessage } from "./VscodeUserMessage"

interface TranscriptRowViewProps {
  row: TranscriptRow
  index?: number
  timeline?: Date
  timing?: { start: number; end?: number; working: boolean }
  section?: boolean
  onForkMessage?: (sessionId: string, messageId: string) => void
  /** Part behind the currently hovered/focused task-timeline bar, if any. */
  highlight?: () => TimelineHighlight | undefined
  activeSearch?: boolean
  /** id of the part (tool call/reasoning block) containing the current chat
   * search match within this row, if any. */
  activeSearchPartID?: string
  /** For a multi-file apply_patch match, the specific file within that part. */
  activeSearchPartFile?: string
}

export const TranscriptRowView: Component<TranscriptRowViewProps> = (props) => {
  const session = useSession()
  const server = useServer()
  const language = useLanguage()
  const vscode = useVSCode()
  const i18n = useI18n()
  const [now, setNow] = createSignal(Date.now())

  createEffect(() => {
    if (!props.timing?.working || props.row.type !== "assistant" || !props.row.first) return
    const id = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => clearInterval(id))
  })
  const duration = () => {
    const value = props.timing
    if (!value) return undefined
    const end = value.working ? now() : value.end
    if (!end || end < value.start) return undefined
    const total = Math.floor((end - value.start) / 1_000)
    const mins = Math.floor(total / 60)
    const secs = total % 60
    return mins ? `${mins}m ${secs}s` : `${secs}s`
  }

  createEffect(() => session.hydrateParts([props.row.message.id]))

  const open = () => vscode.postMessage({ type: "openChanges", turnId: props.row.message.id })

  return (
    <div
      class="vscode-session-turn"
      data-message={props.row.message.id}
      data-row={props.row.type}
      data-row-key={props.row.key}
      data-row-index={props.index}
      data-turn={props.row.turn}
      data-section-break={props.section ? "" : undefined}
      data-live={props.row.live ? "" : undefined}
      data-search-active={props.activeSearch ? "" : undefined}
    >
      <Show when={props.timeline}>{(value) => <MessageTimeline value={value()} />}</Show>
      <Show when={props.row.type === "user" ? props.row : undefined}>
        {(row) => (
          <div
            class="vscode-session-turn-user"
            data-revert-disabled={row().answered && session.status() !== "idle" ? "" : undefined}
            title={row().answered && session.status() !== "idle" ? language.t("revert.disabled.agentBusy") : undefined}
          >
            <VscodeUserMessage
              message={row().message}
              parts={row().parts}
              interrupted={row().interrupted}
              queued={row().queued}
              onFork={
                props.onForkMessage ? () => props.onForkMessage?.(row().message.sessionID, row().message.id) : undefined
              }
              onDelete={
                row().queued ? () => session.deleteQueuedMessage(row().message.sessionID, row().message.id) : undefined
              }
              onEdit={
                row().queued
                  ? (text) => session.editQueuedMessage(row().message.sessionID, row().message.id, text)
                  : undefined
              }
              onRevert={
                row().answered
                  ? () => {
                      if (session.status() !== "idle") return
                      session.revertSession(row().message.id)
                    }
                  : undefined
              }
            />
          </div>
        )}
      </Show>

      <Show when={props.row.type === "assistant" ? props.row : undefined}>
        {(row) => (
          <div class="vscode-session-turn-assistant">
            <Show when={row().first && duration()}>
              <div class="vscode-session-turn-duration" role={props.timing?.working ? "status" : undefined}>
                <span>
                  {props.timing?.working ? "Working for" : "Worked for"} {duration()}
                </span>
                <Icon name="chevron-right" size="small" aria-hidden="true" />
              </div>
            </Show>
            <AssistantMessage
              message={row().message as unknown as SDKAssistantMessage}
              parts={row().parts as unknown as SDKPart[]}
              showAssistantCopyPartID={row().copy}
              forceOpenPartID={props.activeSearchPartID}
              forceOpenFile={props.activeSearchPartFile}
              highlight={props.highlight}
            />
            <Show when={!row().copy}>
              <MessageTime value={row().message} side="assistant" />
            </Show>
          </div>
        )}
      </Show>

      <Show when={props.row.type === "diff" ? props.row : undefined}>
        {(row) => (
          <Show when={server.gitInstalled()}>
            <div class="vscode-session-turn-diffs" data-component="session-turn">
              <button
                type="button"
                class="vscode-session-turn-diffs-trigger"
                onClick={open}
                aria-label={i18n.t("ui.sessionReview.change.modified")}
              >
                <span data-slot="session-turn-diffs-label">{i18n.t("ui.sessionReview.change.modified")}</span>
                <span data-slot="session-turn-diffs-count">
                  {row().diffs.length}{" "}
                  {i18n.t(row().diffs.length === 1 ? "ui.common.file.one" : "ui.common.file.other")}
                </span>
                <span data-slot="session-turn-diffs-meta">
                  <DiffChanges changes={row().diffs as SnapshotFileDiff[]} variant="bars" />
                </span>
                <span data-slot="session-turn-diffs-chevron" aria-hidden="true">
                  <Icon name="chevron-right" size="small" />
                </span>
              </button>
            </div>
          </Show>
        )}
      </Show>

      <Show when={props.row.type === "error" ? props.row : undefined}>
        {(row) => <ErrorDisplay error={row().error as ErrorDisplayProps["error"]} onLogin={server.goToLogin} />}
      </Show>
    </div>
  )
}
