import { For, Show } from "solid-js"
import type { GoalState } from "../../../../src/shared/goal"

export function GoalDeliverables(props: { items?: GoalState["deliverables"] }) {
  return (
    <Show when={props.items}>
      {(items) => (
        <div class="goal-banner__deliverables" aria-label="Goal deliverables">
          <div class="goal-banner__section-title">Deliverables</div>
          <Show when={items().length} fallback={<div class="goal-banner__reason">No cited deliverables.</div>}>
            <For each={items()}>
              {(item) => (
                <div class="goal-banner__deliverable">
                  <span class="goal-banner__deliverable-path" title={item.path}>
                    {item.path}
                  </span>
                  <span class="goal-banner__task-status">
                    {item.kind === "canvas"
                      ? `Canvas version ${item.version} recorded from ${item.tool}.`
                      : item.revision.status === "captured"
                        ? `Revision ${item.revision.sha256.slice(0, 12)} recorded from ${item.tool}.`
                        : `Removal recorded from ${item.tool}.`}
                  </span>
                </div>
              )}
            </For>
          </Show>
        </div>
      )}
    </Show>
  )
}
