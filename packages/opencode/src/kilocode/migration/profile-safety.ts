import { Schema } from "effect"
import { RayaTask } from "../task"
import { RayaGoal } from "../goal"
import { payload } from "./profile-bundle"
import type { z } from "zod"
import { mapper } from "./profile-workspaces"
import { inactiveSQL } from "./profile-inactive-sql"

/** Source evidence stays in the review archive. Unfinished source-device work never becomes destination work. */
export function inactive(source: z.output<typeof payload>, now: number, mapping: ReadonlyMap<string, string>) {
  const translate = mapper(mapping)
  const sql = inactiveSQL(source.sql)
  const json = source.json.flatMap((item) => {
    if (
      [
        "agent-stage",
        "agent-claims",
        "agent-recovery",
        "agent-starts",
        "agent-executions",
        "agent-execution-reviews",
        "scheduler-owners",
        "scheduler-reviews",
        "delegation-reviews",
      ].some((name) => item.path.startsWith(`raya/${name}/`))
    )
      return []
    if (item.path === "raya/agent.json") {
      const agents = Schema.decodeUnknownSync(Schema.Array(RayaTask.Agent))(JSON.parse(item.value))
      return [
        {
          ...item,
          value: JSON.stringify(
            agents.map((agent) => {
              const version = agent.scheduleVersion ?? 1
              if (!Number.isSafeInteger(version) || version < 1 || version >= Number.MAX_SAFE_INTEGER)
                throw new Error("Imported routine schedule version cannot advance safely")
              return Schema.decodeUnknownSync(RayaTask.Agent)({
                ...agent,
                enabled: false,
                dir: agent.dir ? translate(agent.dir) : undefined,
                updatedAt: now,
                scheduleUpdatedAt: now,
                scheduleVersion: version + 1,
                execution: undefined,
                nextRun: undefined,
                tools: [],
                paths: undefined,
                access: "brief",
                provisioning: agent.provisioning
                  ? { ...agent.provisioning, enabled: false, changedAt: now }
                  : undefined,
              })
            }),
          ),
        },
      ]
    }
    if (item.path.startsWith("raya/agent-runs/")) {
      const history = Schema.decodeUnknownSync(RayaTask.History)(JSON.parse(item.value))
      const runs = history.runs.filter((run) => run.status === "complete" || run.status === "error")
      return [
        {
          ...item,
          // Source event cursors belong to the source-device journal. Preserve that
          // complete journal in restore-source; the destination starts without replay.
          value: JSON.stringify({ ...history, runs, events: [], cursor: 0 }),
        },
      ]
    }
    if (item.path.startsWith("raya/goal/")) {
      const goal = Schema.decodeUnknownSync(RayaGoal.State)(JSON.parse(item.value))
      return [
        {
          ...item,
          value: JSON.stringify({
            ...goal,
            status: goal.status === "active" ? "paused" : goal.status,
            activeAt: undefined,
            updatedAt: now,
            dispatch: goal.dispatch?.phase === "finished" ? goal.dispatch : undefined,
            replyRecovery: undefined,
            replyRecoveries: undefined,
          }),
        },
      ]
    }
    return [item]
  })
  // Accounting binds the original source rows. Keep it in retained source evidence,
  // rather than attaching it to deliberately inactive destination rows.
  return payload.parse({
    ...source,
    sql,
    json,
    disposition: undefined,
    restoredArtifacts: undefined,
    restoredComponents: undefined,
    restoredSources: undefined,
  })
}
