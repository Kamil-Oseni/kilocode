import { For, Show } from "solid-js"
import { Icon } from "@kilocode/kilo-ui/icon"
import type { GoalState } from "../../../../src/shared/goal"
import { GoalEvidence } from "./GoalEvidence"

export function GoalAudit(props: {
  sessionID?: string
  revisionID?: string
  goal: Pick<GoalState, "createdAt" | "audit" | "auditAttempt" | "criteria" | "review">
  empty?: boolean
}) {
  const attempt = () =>
    props.goal.auditAttempt ??
    (props.goal.audit
      ? {
          accepted: true,
          reason: undefined,
          requirements: props.goal.audit.requirements,
        }
      : undefined)
  const awaiting = (id?: string) =>
    props.goal.review?.status === "pending" && !!id && props.goal.review.criteria.includes(id)
  return (
    <Show
      when={attempt()}
      fallback={
        <Show when={props.empty}>
          <p>No completion audit was retained for this goal.</p>
        </Show>
      }
    >
      {(record) => (
        <div class="goal-banner__audit" aria-label="Completion audit log">
          <div class="goal-banner__section-title">
            <span>Completion audit</span>
            <span class="goal-banner__audit-verdict" data-accepted={record().accepted ? "" : undefined}>
              {record().accepted ? "Evidence accepted" : "Completion rejected"}
            </span>
          </div>
          <Show when={record().accepted && props.goal.audit?.summary}>{(summary) => <p>{summary()}</p>}</Show>
          <p>
            {record().accepted
              ? "Saved evidence passed the completion checks at submission. Review the cited results for what each check covers; goal-control acceptance, when present, is recorded separately."
              : "The submitted claims below did not pass the completion audit. They are not verified outcomes."}
          </p>
          <Show when={!record().accepted && record().reason}>
            {(reason) => <div class="goal-banner__audit-reason">{reason()}</div>}
          </Show>
          <For each={record().requirements}>
            {(req) => (
              <div
                class="goal-banner__audit-req"
                data-passed={record().accepted && req.passed && !awaiting(req.criterionID) ? "" : undefined}
              >
                <div class="goal-banner__audit-req-head">
                  <Icon
                    name={record().accepted && req.passed && !awaiting(req.criterionID) ? "circle-check" : "circle"}
                    size="small"
                  />
                  <span>{req.requirement}</span>
                </div>
                <Show when={req.criterionID}>
                  {(id) => (
                    <p>
                      Criterion: <code>{id()}</code>
                    </p>
                  )}
                </Show>
                <Show when={awaiting(req.criterionID)}>
                  <p>Evidence is ready; your acceptance is pending.</p>
                </Show>
                <Show when={!record().accepted}>
                  <p>{req.passed ? "Reported satisfied; evidence not accepted." : "Reported unmet."}</p>
                </Show>
                <Show when={record().accepted && !req.passed}>
                  <p>
                    {props.goal.criteria?.some((item) => item.id === req.criterionID && item.required === false)
                      ? "Not verified. Optional criteria do not prevent goal completion."
                      : "Reported unmet."}
                  </p>
                </Show>
                <For each={req.evidence}>
                  {(ev) => (
                    <div class="goal-banner__audit-evidence">
                      <code>{ev.callID}</code>
                      <span>{ev.summary}</span>
                      <Show when={props.sessionID}>
                        {(id) => (
                          <GoalEvidence
                            sessionID={id()}
                            evidence={ev}
                            createdAt={props.goal.createdAt}
                            revisionID={props.revisionID}
                          />
                        )}
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      )}
    </Show>
  )
}
