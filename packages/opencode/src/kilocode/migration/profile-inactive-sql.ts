import type z from "zod"
import type { payload } from "./profile-bundle"

/** Exact inactive SQL projection shared by primary and independent graph restoration. */
export function inactiveSQL(sql: z.output<typeof payload>["sql"]) {
  const terminal: Readonly<Record<string, readonly string[]>> = {
    raya_contact_message: ["delivered", "failed", "cancelled"],
    raya_routine_delegation: ["completed", "failed", "cancelled"],
    raya_routine_occurrence: ["complete", "completed", "failed", "cancelled", "skipped"],
    raya_routine_organization_reservation: ["settled", "released"],
  }
  return sql.map((table) => {
    if (["session_input", "raya_routine_organization_coordinator", "raya_routine_cursor"].includes(table.table))
      return { ...table, rows: [] }
    if (table.table === "raya_contact_receipt") {
      const messages = sql.find((item) => item.table === "raya_contact_message")
      const ids = new Set(
        messages?.rows
          .filter((row) => terminal.raya_contact_message.includes(String(row[messages.columns.indexOf("state")])))
          .map((row) => row[messages.columns.indexOf("id")]),
      )
      return { ...table, rows: table.rows.filter((row) => ids.has(row[table.columns.indexOf("message_id")])) }
    }
    const allowed = terminal[table.table]
    const index = table.columns.indexOf("state")
    const rows = table.rows
      .filter((row) => !allowed || (index >= 0 && allowed.includes(String(row[index]))))
      .map((row) =>
        row.map((value, index) => {
          const column = table.columns[index]
          if (["lease_id", "lease_owner", "lease_until", "claim_id", "owner"].includes(column)) return null
          if (table.table === "raya_contact_destination" && column === "enabled") return 0
          return value
        }),
      )
    return { ...table, rows }
  })
}
