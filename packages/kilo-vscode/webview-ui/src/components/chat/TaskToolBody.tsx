import { Show, type Component, type JSX } from "solid-js"

export const TaskToolBody: Component<{
  contentRef?: (el: HTMLDivElement) => void
  running: boolean
  count: number
  label: string
  report?: JSX.Element
  starting?: JSX.Element
  actions: JSX.Element
  model: JSX.Element
  modelLabel: string
}> = (props) => (
  <div ref={props.contentRef} data-component="task-tools">
    <Show when={props.report}>
      <div data-slot="task-result">{props.report}</div>
    </Show>
    <Show when={props.running && props.count === 0}>{props.starting}</Show>
    <Show when={!props.running && props.count > 0} fallback={props.actions}>
      <details data-slot="task-actions">
        <summary>{props.label}</summary>
        {props.actions}
      </details>
    </Show>
    <details data-slot="task-model-details">
      <summary>{props.modelLabel}</summary>
      <div data-slot="task-model-selection">{props.model}</div>
    </details>
  </div>
)
