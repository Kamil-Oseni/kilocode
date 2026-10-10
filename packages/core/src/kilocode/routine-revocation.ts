// Immutable v1 SQL policy. Changing released statements requires a new migration.
// This is a transactional refusal barrier, not native ownership or stop acknowledgment.
// Scope principals use the actual SQL identity for their kind. Future enrollment must
// retain that correspondence; serialized rows alone cannot authorize enrollment.
const changes = (columns: readonly string[]) =>
  columns.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(" OR ")

const identity = (kind: string, values: readonly string[]) =>
  `(kind = '${kind}' AND principal IN (${values.join(", ")}))`

const session = (values: readonly string[]) => identity("session", values)
const principal = (values: readonly string[]) => identity("principal", values)
const organization = (values: readonly string[]) => identity("organization", values)
const run = (values: readonly string[]) => identity("run", values)
// This bounds negative SQL inspection, not all application payloads. Oversized
// authority JSON revokes its owner without expanding its content arrays.
const valid = (row: string) =>
  `(CASE WHEN length(CAST(${row}.data AS BLOB)) <= 2097152 THEN json_valid(${row}.data) ELSE 0 END)`
const bounded = (row: string) =>
  `CASE WHEN ${valid(row)} THEN (json_type(${row}.data, '$.content') IS NULL OR (json_type(${row}.data, '$.content') = 'array' AND json_array_length(${row}.data, '$.content') <= 1024)) ELSE 0 END`

// Text/reasoning growth is excluded; nested tool identity/input changes are not.
const tools = (row: string) => `CASE
  WHEN json_type(${row}.data, '$.content') IS NULL THEN '[]'
  WHEN json_type(${row}.data, '$.content') IS NOT 'array' THEN ${row}.data
  ELSE (SELECT json_group_array(CASE WHEN json_valid(value) THEN json_object(
    'id', json_extract(value, '$.id'), 'name', json_extract(value, '$.name'),
    'input', json_extract(value, '$.state.input'), 'created', json_extract(value, '$.time.created'),
    'terminal', CASE WHEN json_extract(items.value, '$.id') IN (
      SELECT CASE WHEN json_valid(previous.value) THEN json_extract(previous.value, '$.id') ELSE NULL END
      FROM json_each(OLD.data, '$.content') AS previous
      WHERE CASE WHEN json_valid(previous.value) THEN
        json_extract(previous.value, '$.type') = 'tool'
        AND json_extract(previous.value, '$.state.status') IN ('completed', 'error')
      ELSE 0 END
    ) THEN json_object('state', json_extract(value, '$.state'), 'time', json_extract(value, '$.time'), 'provider', json_extract(value, '$.provider')) ELSE NULL END
  ) ELSE json_object('invalid', value) END)
  FROM json_each(${row}.data, '$.content') AS items
  WHERE CASE WHEN json_valid(value) THEN json_extract(value, '$.type') = 'tool' ELSE 1 END)
END`

function policy(
  table: string,
  columns: readonly string[],
  match: (rows: readonly string[]) => string,
  direct?: (rows: readonly string[]) => string,
  eligible?: (row: string) => string,
  ownership: readonly string[] = [],
  bindings: readonly string[] = [],
  terminal = false,
  content = false,
) {
  return ["INSERT", "UPDATE", "DELETE"].map((event) => {
    const rows = event === "UPDATE" ? ["OLD", "NEW"] : [event === "DELETE" ? "OLD" : "NEW"]
    const predicate = match(rows)
    // Deletion can invalidate a retained proof even when the row was assistant
    // output. Insert/update streaming exclusions never exempt deleting evidence.
    const selection = event !== "DELETE" && eligible ? `(${rows.map(eligible).join(" OR ")})` : "1"
    const fixed = bindings.length
      ? `CASE WHEN ${valid("OLD")} AND ${valid("NEW")} THEN (${bindings.map((field) => `json_extract(OLD.data, '${field}') IS NOT json_extract(NEW.data, '${field}')`).join(" OR ")}) ELSE 1 END`
      : "0"
    const settled = terminal
      ? `CASE WHEN ${valid("OLD")} AND ${valid("NEW")} THEN (json_extract(OLD.data, '$.state.status') IN ('completed', 'error') AND (json_extract(OLD.data, '$.state') IS NOT json_extract(NEW.data, '$.state'))) ELSE 1 END`
      : "0"
    const nested = content
      ? `CASE WHEN (${bounded("OLD")}) AND (${bounded("NEW")}) THEN (${tools("OLD")} IS NOT ${tools("NEW")}) ELSE 1 END`
      : "0"
    const filter =
      event === "UPDATE"
        ? `(${selection} OR ${ownership.length ? changes(ownership) : "0"} OR ${fixed} OR ${settled} OR ${nested})`
        : selection
    const when = event === "UPDATE" ? `(${changes(columns)}) AND ${filter}` : filter
    const capsules = direct ? ` OR (${direct(rows)})` : ""
    return `CREATE TRIGGER raya_routine_authority_${table}_${event.toLowerCase()}
${event === "DELETE" ? "BEFORE" : "AFTER"} ${event} ON ${table}
WHEN ${when}
BEGIN
  UPDATE raya_routine_effect_capsule SET state = 'revoked'
  WHERE state = 'active' AND (
    id IN (
      SELECT m.capsule FROM raya_routine_effect_membership AS m
      JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
      WHERE s.state = 'active' AND (${predicate})
    )${capsules}
  );
  UPDATE raya_routine_effect_scope SET state = 'revoking'
  WHERE state = 'active' AND (${predicate});
END;`
  })
}

const values = (rows: readonly string[], column: string) => rows.map((row) => `${row}.${column}`)
const sessions = (query: string) => session([query])
const projects = (rows: readonly string[], column: string) => {
  const ids = values(rows, column).join(", ")
  return `${sessions(`SELECT id FROM session WHERE project_id IN (${ids})`)} OR ${identity("workspace", [`SELECT id FROM workspace WHERE project_id IN (${ids})`])}`
}
const projectcaps = (rows: readonly string[], column: string) =>
  `session IN (SELECT id FROM session WHERE project_id IN (${values(rows, column).join(", ")}))`
const authored = (row: string) =>
  `CASE WHEN ${valid(row)} THEN json_extract(${row}.data, '$.role') IS NOT 'assistant' ELSE 1 END`
const input = (row: string) =>
  `(NOT ${valid(row)} OR NOT EXISTS (SELECT 1 FROM message WHERE id = ${row}.message_id AND session_id = ${row}.session_id AND CASE WHEN ${valid("message")} THEN json_extract(data, '$.role') = 'assistant' ELSE 0 END))`

// Attempts, memberships, participants and revocation receipts are never rewritten.
// Cursor scans, draft/read badges, timestamps, occurrence lease heartbeats and
// assistant streaming are not authority publications. FS writers remain unenrolled.
export const statements: readonly string[] = Object.freeze([
  ...policy(
    "session",
    [
      "id",
      "project_id",
      "workspace_id",
      "parent_id",
      "directory",
      "path",
      "metadata",
      "revert",
      "permission",
      "agent",
      "model",
      "time_archived",
    ],
    (rows) => session(values(rows, "id")),
    (rows) => `session IN (${values(rows, "id").join(", ")})`,
  ),
  ...policy(
    "message",
    ["id", "session_id", "data", "time_created"],
    (rows) => session(values(rows, "session_id")),
    (rows) => `session IN (${values(rows, "session_id").join(", ")})`,
    authored,
    ["id", "session_id", "time_created"],
    [
      "$.parentID",
      "$.agent",
      "$.mode",
      "$.modelID",
      "$.providerID",
      "$.model",
      "$.variant",
      "$.path",
      "$.request",
      "$.metadata",
      "$.time.created",
    ],
  ),
  ...policy(
    "part",
    ["id", "message_id", "session_id", "data", "time_created"],
    (rows) => session(values(rows, "session_id")),
    (rows) => `session IN (${values(rows, "session_id").join(", ")})`,
    input,
    ["id", "message_id", "session_id", "time_created"],
    ["$.type", "$.tool", "$.callID", "$.state.input", "$.state.time.start"],
    true,
  ),
  ...policy(
    "session_message",
    ["id", "session_id", "type", "seq", "data", "time_created"],
    (rows) => session(values(rows, "session_id")),
    (rows) => `session IN (${values(rows, "session_id").join(", ")})`,
    (row) => `(NOT (${bounded(row)}) OR ${row}.type NOT IN ('assistant', 'tool', 'text', 'reasoning'))`,
    ["id", "session_id", "type", "seq", "time_created"],
    [
      "$.agent",
      "$.model",
      "$.parentID",
      "$.request",
      "$.metadata",
      "$.id",
      "$.name",
      "$.state.input",
      "$.time.created",
    ],
    true,
    true,
  ),
  ...policy(
    "session_input",
    ["id", "session_id", "prompt", "delivery", "admitted_seq", "promoted_seq"],
    (rows) => session(values(rows, "session_id")),
    (rows) => `session IN (${values(rows, "session_id").join(", ")})`,
  ),
  ...policy(
    "session_context_epoch",
    ["session_id", "baseline", "snapshot", "baseline_seq"],
    (rows) => session(values(rows, "session_id")),
    (rows) => `session IN (${values(rows, "session_id").join(", ")})`,
  ),
  ...policy(
    "permission",
    ["id", "project_id", "action", "resource"],
    (rows) => projects(rows, "project_id"),
    (rows) => projectcaps(rows, "project_id"),
  ),
  ...policy(
    "project",
    ["id", "worktree", "vcs", "sandboxes", "commands"],
    (rows) => projects(rows, "id"),
    (rows) => projectcaps(rows, "id"),
  ),
  ...policy(
    "project_directory",
    ["project_id", "directory", "type", "strategy"],
    (rows) => projects(rows, "project_id"),
    (rows) => projectcaps(rows, "project_id"),
  ),
  ...policy(
    "workspace",
    ["id", "type", "branch", "directory", "extra", "project_id"],
    (rows) =>
      `${identity("workspace", values(rows, "id"))} OR ${sessions(`SELECT id FROM session WHERE workspace_id IN (${values(rows, "id").join(", ")})`)}`,
    (rows) => `session IN (SELECT id FROM session WHERE workspace_id IN (${values(rows, "id").join(", ")}))`,
  ),
  ...policy("raya_routine_conversation", ["agent_id", "id"], (rows) => principal(values(rows, "agent_id"))),
  ...policy(
    "raya_routine_message",
    ["id", "agent_id", "source", "kind", "body", "occurrence_id", "session_id", "files", "attachments", "delivery_id"],
    (rows) => `${principal(values(rows, "agent_id"))} OR ${session(values(rows, "session_id"))}`,
    undefined,
    (row) => `${row}.kind NOT IN ('worker', 'report')`,
    ["id", "agent_id", "source", "kind", "session_id"],
  ),
  ...policy(
    "raya_routine_attachment",
    ["id", "agent_id", "message_id", "name", "mime", "size", "data", "sha256"],
    (rows) => principal(values(rows, "agent_id")),
    undefined,
    (row) => `${row}.message_id IS NOT NULL`,
    ["id", "agent_id", "message_id"],
  ),
  ...policy(
    "raya_routine_occurrence",
    ["id", "agent_id", "schedule_version", "scheduled_at", "timezone", "state", "claim_id", "owner", "session_id"],
    (rows) => `${principal(values(rows, "agent_id"))} OR ${session(values(rows, "session_id"))}`,
  ),
  ...policy(
    "raya_routine_delegation",
    [
      "id",
      "source",
      "sender_id",
      "recipient_id",
      "parent_id",
      "parent_run_id",
      "organization_id",
      "organization_revision",
      "workspace",
      "objective",
      "expected",
      "context",
      "deadline",
      "budget",
      "depth",
      "state",
      "child_run_id",
      "session_id",
    ],
    (rows) =>
      `${identity("delegation", values(rows, "id"))} OR ${principal([...values(rows, "sender_id"), ...values(rows, "recipient_id")])} OR ${organization(values(rows, "organization_id"))} OR ${run([...values(rows, "parent_run_id"), ...values(rows, "child_run_id")])} OR ${session(values(rows, "session_id"))}`,
    (rows) =>
      `run IN (${[...values(rows, "parent_run_id"), ...values(rows, "child_run_id")].join(", ")}) OR session IN (${values(rows, "session_id").join(", ")})`,
  ),
  ...policy(
    "raya_routine_organization",
    ["id", "name", "purpose", "policy", "budget", "revision", "archived_at", "stopping_at", "stopped_at"],
    (rows) => organization(values(rows, "id")),
  ),
  ...policy(
    "raya_routine_organization_member",
    ["organization_id", "agent_id", "role", "position", "supervisor_id"],
    (rows) =>
      `${organization(values(rows, "organization_id"))} OR ${principal([...values(rows, "agent_id"), ...values(rows, "supervisor_id")])}`,
  ),
  ...policy(
    "raya_routine_organization_delegation",
    ["organization_id", "sender_id", "recipient_id", "position"],
    (rows) =>
      `${organization(values(rows, "organization_id"))} OR ${principal([...values(rows, "sender_id"), ...values(rows, "recipient_id")])}`,
  ),
  ...policy("raya_routine_organization_revision", ["organization_id", "revision", "definition"], (rows) =>
    organization(values(rows, "organization_id")),
  ),
  ...policy(
    "raya_routine_organization_reservation",
    ["run_id", "agent_id", "organization_id", "organization_revision", "session_id", "budget", "cost", "state"],
    (rows) =>
      `${organization(values(rows, "organization_id"))} OR ${principal(values(rows, "agent_id"))} OR ${run(values(rows, "run_id"))} OR ${session(values(rows, "session_id"))}`,
    (rows) => `run IN (${values(rows, "run_id").join(", ")}) OR session IN (${values(rows, "session_id").join(", ")})`,
  ),
  ...policy(
    "raya_routine_organization_coordinator",
    ["message_id", "session_id", "organization_id", "organization_revision", "state"],
    (rows) => `${organization(values(rows, "organization_id"))} OR ${session(values(rows, "session_id"))}`,
  ),
])
