#!/usr/bin/env bun
// kilocode_change - new file

/**
 * Prevents new service-local runtimes in shared Effect modules while the
 * remaining Kilo Promise facades are migrated away. It also prevents tests
 * from reaching through the global application runtime unless the integration
 * boundary is explicitly classified.
 *
 * Existing sites are allowed only when classified below. Remove transitional
 * entries after their migration lands so later reintroductions fail CI.
 */

import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const DIR = path.join(ROOT, "packages", "opencode", "src")
const TEST_DIR = path.join(ROOT, "packages", "opencode", "test")
const PATTERN = /makeRuntime\s*\(\s*Service\s*,/g
const TEST_PATTERN = /\bAppRuntime\b/g

const allow: Record<string, string> = {
  "bus/index.ts": "core bus callback and synchronous runtime boundary",
  "cli/cmd/run/runtime.boot.ts": "direct run startup resolver runtime boundary",
  "cli/cmd/run/stream.transport.ts": "per-subscription direct run transport runtime boundary",
  "cli/cmd/run/variant.shared.ts": "direct run variant persistence runtime boundary with test filesystem injection",
  "config/tui.ts": "separately tracked TUI config facade moved by the upstream TUI extraction",
  "installation/index.ts": "existing installation facade outside #10655",
}

const testAllow: Record<string, { count: number; reason: string }> = {
  "kilocode/fixtures/scheduler-question-stop.ts": {
    count: 2,
    reason:
      "process-isolated actual scheduled continuation crosses the production runtime into a pending Question and joins both original cancellation owners",
  },
  "preload.ts": { count: 2, reason: "global test-suite AppRuntime cleanup boundary" },
  "kilocode/config-resilience.test.ts": { count: 4, reason: "existing runtime integration test" },
  "kilocode/config-validation.test.ts": { count: 2, reason: "existing runtime integration test" },
  "kilocode/cli-shutdown.fixture.ts": {
    count: 1,
    reason: "process-isolated mocked runtime boundary for shutdown unit tests",
  },
  "kilocode/fixtures/runtime-drain.ts": {
    count: 8,
    reason: "isolated production AppRuntime ownership and all-entrypoint terminal retirement integration",
  },
  "kilocode/plan-followup.test.ts": { count: 3, reason: "existing runtime integration test" },
  "kilocode/task-goal-stop-idle.test.ts": {
    count: 2,
    reason:
      "actual public Goal Stop joins the same production application graph's idle Routine execution and exact task history",
  },
  "kilocode/fixtures/profile-goal-stop-transfer.ts": {
    count: 2,
    reason: "actual public Goal Stop and native encrypted transfer use the same production application writer graph",
  },
  "kilocode/fixtures/config-rmw.ts": {
    count: 10,
    reason:
      "isolated genuine global/project Config services compete with public MCP and agent writers, with original production runtime disposal",
  },
  "kilocode/fixtures/project-config-admission.ts": {
    count: 2,
    reason: "actual project config HTTP and unset Service updates share the production application writer graph",
  },
  "kilocode/session-compaction-chunks.test.ts": {
    count: 2,
    reason: "disk-backed instance integration test cleanup",
  },
  "kilocode/session-fork-remap.test.ts": {
    count: 2,
    reason: "disk-backed instance integration test cleanup",
  },
  "kilocode/kilo-sessions.test.ts": {
    count: 31,
    reason:
      "K1 W1: real integration test for SessionStatus→detach→heartbeat-fence; " +
      "the test creates a session and sets its status via the global AppRuntime, " +
      "then drives the module-level KiloSessions seams and verifies the fence. " +
      "DEF-3 extends this with heartbeat attention-status coverage: the heartbeat " +
      "resolves pending question/permission from the global Question.Service and " +
      "Permission.Service, so a test can only assert it by raising and replying to " +
      "real requests through that same runtime. Scoped layers cannot express this — " +
      "the global-runtime coupling is exactly what is under test. " +
      "PR-link advertise tests extend this with session creation through the same global AppRuntime.",
  },
  "kilocode/session/platform-attribution.test.ts": { count: 2, reason: "existing runtime integration test" },
  "kilocode/session-prompt-queue.test.ts": { count: 6, reason: "prompt queue legacy instance bridge regression" },
  "kilocode/session-prompt-steering.test.ts": {
    count: 2,
    reason: "disk-backed prompt steering integration test cleanup",
  },
  "server/experimental-session-list.test.ts": { count: 2, reason: "Kilo session list integration test" },
  "kilocode/server/cloud-session-import.test.ts": { count: 5, reason: "full app cloud import transaction integration" },
  "kilocode/server/listener-runtime.test.ts": {
    count: 6,
    reason: "listener and shared terminal archive AppRuntime integration test",
  },
  "kilocode/server/http-retirement.fixture.ts": {
    count: 1,
    reason: "isolated production cached HTTP handler retirement closes its realized application runtime owner",
  },
  "kilocode/fixtures/voice-spoken-server.ts": {
    count: 4,
    reason: "fresh-process production listener and shared SQLite receipt inspection for real transport loss",
  },
  "kilocode/fixtures/scheduler-transport.ts": {
    count: 2,
    reason:
      "isolated production application graph drives real local SSE transport, native metadata tool and admitted Routine settlement",
  },
  "kilocode/fixtures/async-prompt-admission.ts": {
    count: 2,
    reason:
      "isolated production HTTP listener verifies accepted async model/tool work and retained native session rows across retirement",
  },
  "kilocode/server/httpapi-child-steer.test.ts": {
    count: 11,
    reason: "real HTTP child steering test spans routed app instances, run ownership, and durable session messages",
  },
  "kilocode/server/httpapi-goal-configuration.test.ts": {
    count: 3,
    reason:
      "actual HTTP Goal configuration and continuation share the server application graph; blocked-state setup and durable dispatch inspection must use the routed InstanceRef in that same runtime",
  },
  "kilocode/server/httpapi-personal-todo-subtask.test.ts": {
    count: 2,
    reason: "real HTTP subtask revision test seeds stored children through the server's shared application runtime",
  },
  "kilocode/server/routine-forecast.test.ts": {
    count: 11,
    reason: "real HTTP routine tests seed legacy/corrupt storage and run history through the server's shared runtime",
  },
  "kilocode/config-repair.test.ts": {
    count: 4,
    reason:
      "full application-runtime repair admission, session, config dependency setup and goal integration; " +
      "verifies source preservation through managed dispatch alongside an ordinary-instance control",
  },
  "tool/recall.test.ts": { count: 11, reason: "existing runtime integration test" },
}

const owned = (file: string) => file.startsWith("kilocode/") || file.startsWith("kilo-sessions/")
const hits: Array<{ file: string; line: number }> = []
const glob = new Bun.Glob("**/*.ts")

for (const entry of glob.scanSync({ cwd: DIR, onlyFiles: true })) {
  const file = entry.replaceAll("\\", "/")
  if (owned(file)) continue
  const text = await Bun.file(path.join(DIR, file)).text()
  for (const match of text.matchAll(PATTERN)) {
    const line = text.slice(0, match.index ?? 0).split("\n").length
    hits.push({ file, line })
  }
}

const invalid = hits.filter((hit) => !allow[hit.file])
const drift = Object.entries(allow).flatMap(([file, reason]) => {
  const count = hits.filter((hit) => hit.file === file).length
  if (count === 1) return []
  return [`  packages/opencode/src/${file}: expected 1 classified site, found ${count} (${reason})`]
})

const testHits: Array<{ file: string; line: number }> = []
for (const entry of glob.scanSync({ cwd: TEST_DIR, onlyFiles: true })) {
  const file = entry.replaceAll("\\", "/")
  const text = await Bun.file(path.join(TEST_DIR, file)).text()
  for (const match of text.matchAll(TEST_PATTERN)) {
    const line = text.slice(0, match.index ?? 0).split("\n").length
    testHits.push({ file, line })
  }
}

const testInvalid = testHits.filter((hit) => !testAllow[hit.file])
const testDrift = Object.entries(testAllow).flatMap(([file, entry]) => {
  const count = testHits.filter((hit) => hit.file === file).length
  if (count === entry.count) return []
  return [
    `  packages/opencode/test/${file}: expected ${entry.count} classified reference(s), found ${count} (${entry.reason})`,
  ]
})

if (invalid.length > 0 || drift.length > 0 || testInvalid.length > 0 || testDrift.length > 0) {
  if (invalid.length > 0) {
    console.error("Found unclassified service-local Effect runtimes in shared opencode modules:")
    for (const hit of invalid) console.error(`  packages/opencode/src/${hit.file}:${hit.line}`)
    console.error("")
  }
  if (drift.length > 0) {
    console.error("Classified service-local runtime exceptions no longer match the current source:")
    for (const item of drift) console.error(item)
    console.error("")
  }
  if (testInvalid.length > 0) {
    console.error("Found unclassified AppRuntime use in opencode tests:")
    for (const hit of testInvalid) console.error(`  packages/opencode/test/${hit.file}:${hit.line}`)
    console.error("")
  }
  if (testDrift.length > 0) {
    console.error("Classified test AppRuntime exceptions no longer match the current source:")
    for (const item of testDrift) console.error(item)
    console.error("")
  }
  console.error("Do not add Promise facades to shared Effect services or global AppRuntime dependencies to tests.")
  console.error("Yield services directly in scoped layers, or classify intentional integration boundaries explicitly.")
  console.error("Remove migrated exceptions, or classify intentional runtime changes with an explicit reason.")
  process.exit(1)
}

console.log(
  `check-opencode-promise-facades: ${hits.length} classified runtime site(s), ${testHits.length} classified test reference(s), no runtime drift found.`,
)
