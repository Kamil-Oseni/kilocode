import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import migration from "@opencode-ai/core/database/migration/20260926010000_kilocode-private-desktop-frames"
import { scrub } from "@opencode-ai/core/kilocode/desktop-frame-retention"

function part(tool: string, state: Record<string, unknown>) {
  return { type: "tool", tool, callID: "call_old", state }
}

describe("legacy desktop frame retention", () => {
  test("scrubs only desktop pixels, keeping receipt text, policy metadata and non-image files", () => {
    const old = part("desktop_observe", {
      status: "completed",
      output: "Window observed; receipt=abc data:image/png;base64,cG5n",
      title: "Observed desktop",
      metadata: { receipt: "abc", nested: ["data:image/jpeg;base64,Zm9v"] },
      attachments: [
        { type: "file", mime: "image/png", url: "data:image/png;base64,cG5n" },
        { type: "file", mime: "text/plain", url: "data:text/plain;base64,aGVsbG8=" },
      ],
    })
    const next = scrub(old)
    expect(JSON.stringify(next)).not.toContain("data:image/")
    expect(next).toMatchObject({
      state: {
        output: "Window observed; receipt=abc [private media omitted]",
        metadata: { receipt: "abc", nested: ["[private media omitted]"] },
        attachments: [{ mime: "text/plain", url: "data:text/plain;base64,aGVsbG8=" }],
      },
    })
    expect(scrub(next)).toEqual(next)
    expect(scrub(part("browser_screenshot", old.state))).toEqual(part("browser_screenshot", old.state))
    expect(
      scrub(part("desktop_watch", { status: "running", attachments: [{ url: "data:image/jpeg;base64,Zm9v" }] })),
    ).toMatchObject({ state: { status: "running" } })
  })

  test("real SQLite migration uses its journal and leaves other tool images untouched", async () => {
    const desktop = part("desktop_observe", {
      status: "completed",
      output: "receipt 123",
      metadata: { observation: "obs_1" },
      attachments: [{ mime: "image/png", url: "data:image/png;base64,cG5n" }],
    })
    const browser = part("browser_screenshot", {
      status: "completed",
      attachments: [{ mime: "image/png", url: "data:image/png;base64,YmFy" }],
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Database.Service
          const db = service.db
          yield* db.run("PRAGMA foreign_keys = OFF")
          yield* db.run(
            sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (${"prt_desktop"}, 'msg_old', 'ses_old', 1, 1, ${JSON.stringify(desktop)})`,
          )
          yield* db.run(
            sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (${"prt_browser"}, 'msg_old', 'ses_old', 1, 1, ${JSON.stringify(browser)})`,
          )
          yield* db.run(
            sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (${"prt_broken"}, 'msg_old', 'ses_old', 1, 1, ${"not-json"})`,
          )
          yield* db.run(sql`DELETE FROM migration WHERE id = ${migration.id}`)
          yield* DatabaseMigration.applyOnly(db, [migration])

          const first = JSON.parse(
            (yield* db.get<{ data: string }>("SELECT data FROM part WHERE id = 'prt_desktop'"))!.data,
          )
          const other = JSON.parse(
            (yield* db.get<{ data: string }>("SELECT data FROM part WHERE id = 'prt_browser'"))!.data,
          )
          expect(first.state).toMatchObject({ output: "receipt 123", metadata: { observation: "obs_1" } })
          expect(first.state.attachments).toBeUndefined()
          expect(other).toEqual(browser)
          expect(yield* db.get("SELECT data FROM part WHERE id = 'prt_broken'")).toEqual({ data: "not-json" })
          expect(yield* db.get(sql`SELECT count(*) AS total FROM migration WHERE id = ${migration.id}`)).toEqual({
            total: 1,
          })

          yield* DatabaseMigration.applyOnly(db, [migration])
          expect(
            JSON.parse((yield* db.get<{ data: string }>("SELECT data FROM part WHERE id = 'prt_desktop'"))!.data),
          ).toEqual(first)
        }).pipe(Effect.provide(Database.layerFromPath(":memory:"))),
      ),
    )
  })
})
