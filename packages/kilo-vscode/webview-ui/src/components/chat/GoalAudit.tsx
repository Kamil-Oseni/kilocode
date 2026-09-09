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
              {record().accepted ? "Evidence references accepted" : "Completion rejected"}
            </span>
          </div>
          <Show when={record().accepted && props.goal.audit?.summary}>{(summary) => <p>{summary()}</p>}</Show>
          <p>
            {record().accepted
              ? "The cited tool results passed the evidence-reference checks at submission. This does not establish that they cover every part of the requested outcome. Compare each result with its requested verification below."
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
                <Show when={props.goal.criteria?.find((item) => item.id === req.criterionID)}>
                  {(criterion) => (
                    <>
                      <p>Requested verification: {criterion().verification}</p>
                      <Show when={criterion().check}>
                        {(check) => (
                          <div aria-label="Required command binding">
                            <p>
                              Required command: <code>{check().command}</code>
                            </p>
                            <p>
                              Working directory: <code>{check().directory}</code>
                            </p>
                          </div>
                        )}
                      </Show>
                    </>
                  )}
                </Show>
                <Show when={record().accepted && req.passed}>
                  <p>Reported satisfied; evidence references accepted.</p>
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
                <Show when={req.evidence.length}>
                  <strong>Cited results</strong>
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
          <Show when={record().accepted}>
            <section aria-label="Completion review limits">
              <strong>What remains to review</strong>
              <p>
                Open the cited sources to inspect the recorded inputs, outputs, and artifact details. Opening this audit
                does not rerun checks or confirm later file changes.
              </p>
              <Show when={record().requirements.some((item) => !item.passed)}>
                <p>Some criteria remain unverified; their limitations are listed above.</p>
              </Show>
              <p>
                {props.goal.review?.status === "accepted"
                  ? "User review: acceptance was recorded through goal controls. It does not verify later changes or identify a person."
                  : props.goal.review?.status === "pending"
                    ? "User review: acceptance is pending. Review the cited results before using Accept reviewed goal, or use Steer to request changes."
                    : "User review: no separate acceptance was recorded. Evidence-reference acceptance is not user acceptance."}
              </p>
            </section>
          </Show>
        </div>
      )}
    </Show>
  )
}
