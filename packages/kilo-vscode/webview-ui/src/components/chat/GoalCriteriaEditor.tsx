import { Index } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import type { GoalState } from "../../../../src/shared/goal"

export function GoalCriteriaEditor(props: {
  value: NonNullable<GoalState["criteria"]>
  disabled?: boolean
  onChange: (value: NonNullable<GoalState["criteria"]>) => void
}) {
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
