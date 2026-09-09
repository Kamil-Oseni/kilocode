import { next } from "../../../src/kilocode/task/cron"

console.log(
  JSON.stringify({
    zone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    at: next("0 9 * * 1-5", Date.parse("2026-07-06T00:00:00Z"), "America/Toronto"),
  }),
)
