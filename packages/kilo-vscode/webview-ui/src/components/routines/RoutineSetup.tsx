import { Show, type Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import type { Output } from "../../../../src/shared/routine-output"
import type { Draft } from "../../../../src/shared/routine-schedule"
import { ScheduleEditor } from "./ScheduleEditor"

type Step = "job" | "schedule" | "budget" | "review"

function label(draft: Draft) {
  if (draft.mode === "manual") return "Only when you ask"
  if (draft.mode === "event")
    return draft.filtered
      ? `When ${draft.source || "the event"} is ${draft.branch}`
      : `When ${draft.source || "the event"} arrives`
  if (draft.mode === "once") return `Once, ${draft.delay || "0"} ${draft.unit} after review`
  if (draft.mode === "date")
    return draft.local ? `Once on ${new Date(draft.local).toLocaleString()}` : "Once on a date you choose"
  if (draft.mode === "cron") return `${draft.expr || "Cron schedule"}${draft.zone ? ` · ${draft.zone}` : ""}`
  if (draft.mode === "monthly") return `Monthly on day ${draft.day || "1"} at ${draft.time}`
  if (draft.mode === "daily") return `Every day at ${draft.time}`
  const days = draft.days.map((day) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]).join(", ")
  return `${days || "Selected weekdays"} at ${draft.time}`
}

const RoutineSetup: Component<{
  step: Step
  name: string
  job: string
  draft: Draft
  output: Output
  role: string
  access: string
  dir: string
  budget: string
  saving: boolean
  onStep: (step: Step) => void
  onName: (value: string) => void
  onJob: (value: string) => void
  onDraft: (value: Draft) => void
  onBudget: (value: string) => void
}> = (props) => {
  const number = () => (props.step === "job" ? 1 : props.step === "schedule" ? 2 : props.step === "budget" ? 3 : 4)
  const valid = () => {
    if (!props.budget.trim()) return true
    const amount = Number(props.budget)
    return Number.isFinite(amount) && amount > 0 && amount <= 1_000_000
  }
  return (
    <div class="routines-setup" data-step={props.step}>
      <div class="routines-setup-progress" aria-label={`Routine setup, step ${number()} of 4`}>
        <span>{number()} of 4</span>
        <span>{props.step === "review" ? "Review" : "Set up routine"}</span>
      </div>

      <Show when={props.step !== "job"}>
        <div class="routines-setup-exchange">
          <p class="routines-setup-prompt">What should this worker take care of?</p>
          <div class="routines-setup-answer">
            <strong>{props.name.trim() || "New worker"}</strong>
            <span>{props.job}</span>
          </div>
        </div>
      </Show>
      <Show when={props.step === "budget" || props.step === "review"}>
        <div class="routines-setup-exchange">
          <p class="routines-setup-prompt">When should it work?</p>
          <div class="routines-setup-answer">{label(props.draft)}</div>
        </div>
      </Show>

      <Show when={props.step === "job"}>
        <section class="routines-question" aria-labelledby="routine-job-question">
          <h3 id="routine-job-question">What should this worker take care of?</h3>
          <p>Describe one standing responsibility. You can refine the details before assigning it.</p>
          <label class="routines-field">
            Standing job
            <textarea
              required
              value={props.job}
              onInput={(event) => props.onJob(event.currentTarget.value)}
              placeholder="Review Friday accounts, flag anything unusual, and send me a short report."
              rows={5}
              autofocus
            />
          </label>
          <label class="routines-field">
            <span class="routines-label">
              Worker name <span class="routines-optional">(optional)</span>
            </span>
            <input
              value={props.name}
              onInput={(event) => props.onName(event.currentTarget.value)}
              placeholder="Friday accounts"
            />
          </label>
          <div class="routines-question-footer">
            <span class="routines-hint">Enter the standing job to continue.</span>
            <Button type="button" disabled={!props.job.trim()} onClick={() => props.onStep("schedule")}>
              Continue
            </Button>
          </div>
        </section>
      </Show>

      <Show when={props.step === "schedule"}>
        <section class="routines-question" aria-labelledby="routine-schedule-question">
          <h3 id="routine-schedule-question">When should it work?</h3>
          <p>Choose a schedule. Raya will show the exact upcoming runs before saving.</p>
          <ScheduleEditor value={props.draft} onChange={props.onDraft} disabled={props.saving} />
          <div class="routines-question-footer">
            <Button type="button" variant="ghost" onClick={() => props.onStep("job")}>
              Back
            </Button>
            <Button type="button" onClick={() => props.onStep("budget")}>
              Continue
            </Button>
          </div>
        </section>
      </Show>

      <Show when={props.step === "budget"}>
        <section class="routines-question" aria-labelledby="routine-budget-question">
          <h3 id="routine-budget-question">Should one run have a cost limit?</h3>
          <p>Set an optional model-cost ceiling. Raya stops that run when it reaches the amount.</p>
          <label class="routines-field">
            <span class="routines-label">
              Per-run limit <span class="routines-optional">(optional)</span>
            </span>
            <input
              type="number"
              min="0.01"
              max="1000000"
              step="0.01"
              value={props.budget}
              onInput={(event) => props.onBudget(event.currentTarget.value)}
              placeholder="No saved limit"
              autofocus
            />
          </label>
          <div class="routines-question-footer">
            <Button type="button" variant="ghost" onClick={() => props.onStep("schedule")}>
              Back
            </Button>
            <Button type="button" disabled={!valid()} onClick={() => props.onStep("review")}>
              Review choices
            </Button>
          </div>
        </section>
      </Show>

      <Show when={props.step === "review"}>
        <section class="routines-review" aria-labelledby="routine-review-heading">
          <div class="routines-form-heading">
            <h3 id="routine-review-heading">Review this routine</h3>
            <p>Nothing is saved until you assign it.</p>
          </div>
          <dl class="routines-review-list">
            <div>
              <dt>Worker</dt>
              <dd>
                <span>{props.name.trim() || props.role}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  aria-label="Edit worker"
                  onClick={() => props.onStep("job")}
                >
                  Edit
                </Button>
              </dd>
            </div>
            <div>
              <dt>Job</dt>
              <dd>
                <span>{props.job}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  aria-label="Edit job"
                  onClick={() => props.onStep("job")}
                >
                  Edit
                </Button>
              </dd>
            </div>
            <div>
              <dt>Schedule</dt>
              <dd>
                <span>{label(props.draft)}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  aria-label="Edit schedule"
                  onClick={() => props.onStep("schedule")}
                >
                  Edit
                </Button>
              </dd>
            </div>
            <div>
              <dt>Cost limit</dt>
              <dd>
                <span>
                  {props.budget.trim() ? `$${Number(props.budget).toLocaleString()} per run` : "No saved limit"}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  aria-label="Edit cost limit"
                  onClick={() => props.onStep("budget")}
                >
                  Edit
                </Button>
              </dd>
            </div>
            <div>
              <dt>Reports</dt>
              <dd>{props.output.description}</dd>
            </div>
            <div>
              <dt>Workspace</dt>
              <dd>{props.dir || "Choose a folder"}</dd>
            </div>
            <div>
              <dt>Access</dt>
              <dd>{props.access}</dd>
            </div>
          </dl>
        </section>
      </Show>
    </div>
  )
}

export default RoutineSetup
