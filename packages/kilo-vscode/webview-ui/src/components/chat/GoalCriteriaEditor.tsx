import { GoalBinding } from "./GoalBinding"
import { Index, Show } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import type { GoalState } from "../../../../src/shared/goal"

export function GoalCriteriaEditor(props: {
  value: NonNullable<GoalState["criteria"]>
  disabled?: boolean
  onChange: (value: NonNullable<GoalState["criteria"]>) => void
}) {
  const command = (item: NonNullable<GoalState["criteria"]>[number]) =>
    item.check?.kind === "command" ? item.check : undefined
  let root: HTMLFieldSetElement | undefined
  const focus = (id: string) =>
    queueMicrotask(() => root?.querySelector<HTMLTextAreaElement>(`[data-criterion="${id}"]`)?.focus())
  return (
    <fieldset ref={root} class="goal-banner__criteria-editor" disabled={props.disabled}>
      <legend>Acceptance criteria</legend>
      <p>
        Describe the outcome and how to verify it. Required criteria must pass; optional ones can remain unverified.
      </p>
      <Index each={props.value}>
        {(item, index) => (
          <div>
            <label>
              <input
                type="checkbox"
                checked={item().required !== false}
                onChange={(event) =>
                  props.onChange(
                    props.value.map((entry, i) =>
                      i === index ? { ...entry, required: event.currentTarget.checked } : entry,
                    ),
                  )
                }
              />
              Criterion {index + 1} is required
            </label>
            <label>
              <input
                type="checkbox"
                checked={item().review === true}
                onChange={(event) =>
                  props.onChange(
                    props.value.map((entry, i) =>
                      i === index ? { ...entry, review: event.currentTarget.checked } : entry,
                    ),
                  )
                }
              />
              Criterion {index + 1} needs my review before completion
            </label>
            <label>
              Criterion {index + 1}
              <textarea
                data-criterion={item().id}
                rows="2"
                maxLength={4000}
                value={item().description}
                onInput={(event) =>
                  props.onChange(
                    props.value.map((entry, i) =>
                      i === index ? { ...entry, description: event.currentTarget.value } : entry,
                    ),
                  )
                }
              />
            </label>
            <label>
              Verification for criterion {index + 1}
              <textarea
                rows="2"
                maxLength={4000}
                value={item().verification}
                onInput={(event) =>
                  props.onChange(
                    props.value.map((entry, i) =>
                      i === index ? { ...entry, verification: event.currentTarget.value } : entry,
                    ),
                  )
                }
              />
            </label>
            <Show when={item().check?.kind === "byte-equality"}>
              <GoalBinding check={item().check} />
            </Show>
            <Show when={item().check?.kind !== "byte-equality"}>
              <label>
                <input
                  type="checkbox"
                  checked={!!item().check}
                  onChange={(event) =>
                    props.onChange(
                      props.value.map((entry, i) =>
                        i === index
                          ? {
                              ...entry,
                              check: event.currentTarget.checked
                                ? { kind: "command", command: "", directory: "" }
                                : undefined,
                            }
                          : entry,
                      ),
                    )
                  }
                />
                Require an exact command result for criterion {index + 1}
              </label>
              <Show when={item().check?.kind === "command"}>
                <p>
                  The cited command must match this text, use this explicit absolute working directory, and exit
                  successfully. This does not run it or grant permission.
                </p>
                <label>
                  Command for criterion {index + 1}
                  <textarea
                    rows="2"
                    maxLength={4000}
                    value={command(item())?.command ?? ""}
                    onInput={(event) =>
                      props.onChange(
                        props.value.map((entry, i) =>
                          i === index && entry.check?.kind === "command"
                            ? { ...entry, check: { ...entry.check, command: event.currentTarget.value } }
                            : entry,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  Absolute working directory for criterion {index + 1}
                  <input
                    type="text"
                    maxLength={4000}
                    value={command(item())?.directory ?? ""}
                    onInput={(event) =>
                      props.onChange(
                        props.value.map((entry, i) =>
                          i === index && entry.check?.kind === "command"
                            ? { ...entry, check: { ...entry.check, directory: event.currentTarget.value } }
                            : entry,
                        ),
                      )
                    }
                  />
                </label>
              </Show>
            </Show>
            <Button
              size="small"
              variant="ghost"
              aria-label={`Remove criterion ${index + 1}`}
              onClick={() => {
                const next = props.value.filter((_, i) => i !== index)
                props.onChange(next)
                const item = next[Math.min(index, next.length - 1)]
                if (item) focus(item.id)
                if (!item) queueMicrotask(() => root?.querySelector<HTMLButtonElement>("[data-add-criterion]")?.focus())
              }}
            >
              Remove criterion
            </Button>
          </div>
        )}
      </Index>
      <Button
        size="small"
        variant="ghost"
        data-add-criterion
        disabled={props.value.length >= 20}
        onClick={() => {
          const id = crypto.randomUUID()
          props.onChange([...props.value, { id, description: "", verification: "" }])
          focus(id)
        }}
      >
        Add criterion
      </Button>
    </fieldset>
  )
}
