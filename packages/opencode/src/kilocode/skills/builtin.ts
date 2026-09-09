// kilocode_change - new file
// Built-in skills that ship inside the CLI binary.
// Content is inlined at compile time via Bun's static import of .md files.
// Registered before all discovery phases so user skills with the same name override.

import KILO_CONFIG from "./kilo-config.md" with { type: "text" }
import BROWSER from "./browser/SKILL.md" with { type: "text" }
import WORKFLOWS from "./browser-workflows/SKILL.md" with { type: "text" }
import RECOVERY from "./browser-recovery/SKILL.md" with { type: "text" }
import RUNTIME from "./browser-runtime/SKILL.md" with { type: "text" }

export interface BuiltinSkill {
  name: string
  description: string
  content: string
}

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    name: "browser",
    description:
      "Operate Raya's shared browser for browsing, research, forms, authenticated work, UI testing, and rendered design inspection. Load for browser tasks to ground actions and verify results.",
    content: BROWSER,
  },
  {
    name: "browser-workflows",
    description:
      "Task playbooks for the browser skill: research, forms, authentication, file transfers, smoke testing, and visual inspection. Load the relevant playbook when performing these browser workflows.",
    content: WORKFLOWS,
  },
  {
    name: "browser-recovery",
    description:
      "Recover browser work after stale or ambiguous targets, interrupted actions, login challenges, and untrusted page instructions. Load when browser progress fails or destination state is uncertain.",
    content: RECOVERY,
  },
  {
    name: "browser-runtime",
    description:
      "Versioned capability reference for Raya's browser tools, including parameters, smoke assertions, and unsupported operations. Load before selecting browser operations or interpreting runtime evidence.",
    content: RUNTIME,
  },
  {
    name: "kilo-config",
    description:
      "Guide for Kilo configuration: config paths, kilo.json fields, commands, agents, skills, permissions, MCPs, providers, TUI settings, plus Agent Manager worktree setup/run scripts, workflows, and state. Use for Kilo config questions, locating loaded config, changing settings, or Agent Manager questions about run/setup scripts, worktree setup/workflows, apply/merge/PR/conflicts, missing sessions/worktrees, and agent-manager.json recovery.",
    content: KILO_CONFIG,
  },
]
