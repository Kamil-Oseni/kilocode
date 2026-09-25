import { Icon } from "@kilocode/kilo-ui/icon"
import { Show, type Component } from "solid-js"
import { ChatView } from "./ChatView"

export type SubagentTarget = {
  sessionID: string
  title?: string
  parentSessionID?: string
  parentTitle?: string
}

type Props = {
  target?: SubagentTarget
  sessionTitle?: string
  onParentClick: () => void
}

export const SubagentViewer: Component<Props> = (props) => (
  <div data-component="subagent-viewer">
    <Show when={props.target?.parentSessionID}>
      <nav data-slot="subagent-breadcrumb" aria-label="Conversation path">
        <button type="button" onClick={props.onParentClick}>
          <Icon name="arrow-left" size="small" aria-hidden="true" />
          <span>{props.target?.parentTitle?.trim() || "Back to main chat"}</span>
        </button>
        <span>{props.target?.title?.trim() || props.sessionTitle || "Subagent"}</span>
      </nav>
    </Show>
    <ChatView readonly />
  </div>
)
