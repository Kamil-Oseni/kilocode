# Raya Scheduled & Background Agents — Build Plan

This document is a build plan only. Nothing here is implemented yet. It describes a task-type feature where an agent is given a long-lived, recurring, or triggered assignment and acts on it on its own schedule — "remind me every day to do X and Y", "review Eden's accounting and legal every weekend" — running in the background or in a fresh session when there is genuine work to do, rather than idling and burning tokens.

## What this is, and what it is not

A goal, as Raya has it today, is a persistent objective within one conversation that drives continuation until the work is verified or honestly blocked. A scheduled task is a level above that: a standing assignment that lives outside any single conversation, wakes on a schedule or a trigger, spawns a run to do the work, and then goes back to sleep. Grok's scheduled tasks are the right mental model — the agent is dormant until its time comes, does the job, reports, and waits again.

The distinction to hold onto is that a task is a definition plus a schedule plus a history, while a run is a single execution of that task inside a real session. The task persists; runs come and go. Keeping these separate is what prevents the token-burn the current always-continuing goal loop can cause, because nothing runs between scheduled wakeups.

## Architecture

The feature has four parts: a durable task store, a scheduler that decides when to wake, a runner that executes a task as a background session, and a surface to create and review tasks.

The task store holds each task's definition and its run history. A task record needs an objective in plain language, a schedule (a cron-like recurrence, a fixed time, or an event trigger), the agent or role that should run it, an enabled flag, the timestamp of the last run and the computed next run, and a bounded log of recent runs with their outcomes. This is the same shape of durable, storage-backed state the goal system already uses, so it should live alongside it and reuse that persistence layer rather than inventing a new one.

The scheduler is the only genuinely new runtime piece. It is a single long-lived loop, owned by the backend, that periodically inspects the task store, finds tasks whose next run has arrived or whose trigger has fired, and hands each to the runner. It must be resilient across restarts — on startup it recomputes next-run times from the stored schedules rather than trusting an in-memory timer — and it must not double-fire, so a task that is already running is skipped until its run completes. Keep the tick coarse (once a minute is plenty) and do all the real timing math from stored schedules.

The runner turns a fired task into work. It opens a fresh session (or a background session that does not steal the user's foreground context), seeds it with the task objective exactly as a `/goal` arming would, lets the existing goal machinery drive the run to completion or a blocked state, records the outcome and evidence back onto the task's history, and then closes the session. Reusing the goal runtime here is the whole trick: a scheduled run is just a goal that something other than a human started. The completion audit, the evidence trail, and the blocked-with-reason behavior all come for free.

The surface is where you define and inspect tasks: a list of standing tasks with their schedules and next-run times, a create/edit form, an enable/disable toggle, and a per-task history showing each run's result. Reminder-style tasks ("remind me to do X") resolve to a notification plus a short summary rather than code work, so the runner needs a lightweight "notify" outcome in addition to the full work-and-verify path.

## Schedules and triggers

Support three kinds of activation, in increasing order of effort. A one-shot time ("at 9am tomorrow, do X") is the simplest and validates the whole pipeline. A recurrence ("every day", "every weekend") is a cron-like rule the scheduler evaluates on each tick. An event trigger ("when the Eden repo gets a new release", "when this file changes") is the most powerful and the most work, because it needs a source of events to watch; defer it until the time-based paths are solid.

For the recurrence syntax, lean on a well-understood cron expression rather than inventing a format, and let the create form translate plain English ("every weekend") into that expression so the stored rule stays unambiguous while the user never has to write cron by hand.

## Guardrails against runaway cost

The point of this feature is to stop idle token burn, so the guardrails are not optional. Every task must have an owner-visible enabled flag and be trivially pausable. Each run must inherit the same step and continuation caps the goal system already enforces, so a single scheduled run cannot loop forever. Overlapping runs of the same task are forbidden — if a weekly review is somehow still running when the next week arrives, skip rather than stack. And the run history should surface cost per run so a task that quietly becomes expensive is visible rather than hidden. A task that repeatedly blocks on the same reason should auto-disable after a small number of consecutive failures and tell you why, instead of failing on schedule forever.

## Recommended build order

1. Build the task store and a manual "run now" button first, with no scheduler at all. This proves that a stored task definition can seed a background session and drive a goal run to completion, which is the riskiest integration.
2. Add the scheduler loop with one-shot times only, so a task fires once at a set time. This validates wakeup, no-double-fire, and restart resilience on the simplest possible schedule.
3. Add cron-style recurrence and the plain-English translation in the create form.
4. Add the reminder/notify outcome path so non-code tasks resolve cleanly.
5. Add event triggers last, once there is a real event source worth watching.

## Where it connects to the rest of Raya

This feature is the natural counterpart to the mobile companion. Scheduled runs happen while you are away, so their outcomes are exactly what you want to glance at from your phone, and a run that blocks on approval is exactly the case the mobile permission-prompt surface is meant to resolve. Build the two with that pairing in mind: a scheduled agent that can pause for remote approval and report to a phone is the "agents that work when they need to work" experience you are aiming for.
