import { Icon } from "@kilocode/kilo-ui/icon"
import { Show, type Component } from "solid-js"
import { ChatView } from "./ChatView"
import { ChildSteerComposer } from "./ChildSteerComposer"

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
          {props.target?.parentTitle?.trim() || "Parent conversation"}
        </button>
        <Icon name="chevron-right" size="small" />
        <span>{props.target?.title?.trim() || props.sessionTitle || "Sub-agent"}</span>
      </nav>
    </Show>
    <ChatView readonly />
    <ChildSteerComposer parentSessionID={props.target?.parentSessionID} childSessionID={props.target?.sessionID} />
  </div>
)
