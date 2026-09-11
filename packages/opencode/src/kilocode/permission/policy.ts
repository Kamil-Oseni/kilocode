import { Effect } from "effect"
import type { Config } from "@/config/config"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"

type Normalize = (value: ConfigPermissionV1.Info) => PermissionV1.Ruleset
type Snapshot = { rules: PermissionV1.Ruleset; rest: string }

function tuple(rule: PermissionV1.Rule) {
  return [rule.permission, rule.pattern, rule.action] as const
}

function key(rule: PermissionV1.Rule) {
  return JSON.stringify([rule.permission, rule.pattern])
}

/** Compare authority, excluding display/model settings and derived provenance. Rule order remains significant. */
function snapshot(cfg: Config.Info, normalize: Normalize): Snapshot {
  const agents = (value: Config.Info["agent"]) =>
    Object.entries(value ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, agent]) => [name, normalize(agent?.permission ?? {}).map(tuple), agent?.tools ?? {}])
  return {
    rules: normalize(cfg.permission ?? {}),
    rest: JSON.stringify({ agent: agents(cfg.agent), mode: agents(cfg.mode), tools: cfg.tools, sandbox: cfg.sandbox }),
  }
}

/** Explicit saved rules must not invalidate their own pending approval, or covered siblings. */
function compatible(before: Snapshot, after: Snapshot, saved: PermissionV1.Ruleset) {
  if (before.rest !== after.rest) return false
  const expected = new Set(
    after.rules
      .filter((rule) => saved.some((item) => key(item) === key(rule) && item.action === rule.action))
      .map(key),
  )
  // Saving a pattern grant replaces a scalar `ask` with an object. In the
  // absence of permission wildcards, its missing catch-all still defaults to ask.
  const defaults = new Set(
    before.rules
      .filter(
        (rule) =>
          rule.action === "ask" &&
          rule.pattern === "*" &&
          !before.rules.some((item) => /[*?]/.test(item.permission)) &&
          !after.rules.some((item) => /[*?]/.test(item.permission)) &&
          !after.rules.some((item) => key(item) === key(rule)) &&
          after.rules.some((item) => item.permission === rule.permission && expected.has(key(item))),
      )
      .map(key),
  )
  const retained = (rules: PermissionV1.Ruleset) =>
    rules.filter((rule) => !expected.has(key(rule)) && !defaults.has(key(rule))).map(tuple)
  return JSON.stringify(retained(before.rules)) === JSON.stringify(retained(after.rules))
}

export function capture(config: Pick<Config.Interface, "get">, normalize: Normalize) {
  return Effect.gen(function* () {
    const before = snapshot(yield* config.get(), normalize)
    const saved: PermissionV1.Rule[] = []
    return {
      current: () => config.get().pipe(Effect.map((cfg) => compatible(before, snapshot(cfg, normalize), saved))),
      accept: (rules: PermissionV1.Ruleset) => saved.push(...rules),
    }
  })
}
