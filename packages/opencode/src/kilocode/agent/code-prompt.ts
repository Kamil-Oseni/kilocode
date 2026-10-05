type Agent = { name: string; mode: string; prompt?: string }

const defaults = new WeakMap<Agent, string>()
const guidance = `Preserve explicit execution constraints. When the user supplies an exact shell command and working directory, use that command unchanged and pass the directory through the workdir parameter; do not substitute commands, prepend cd, or rely on an unrelated default directory. Keep edits and verification within the requested scope. If the exact operation cannot be performed, report the obstacle instead of silently replacing it.

Honor the requested exact final response after the work succeeds, without adding a summary or explanation. Otherwise report the actual failure honestly. Only claim completion from observed tool results; a failed check is not success.`

export namespace CodePrompt {
  export function register(agent: Agent) {
    if (agent.prompt) defaults.set(agent, agent.prompt)
  }

  export function prepare(agent: Agent, provider: string[]) {
    if (
      agent.name === "code" &&
      agent.mode === "primary" &&
      defaults.has(agent) &&
      defaults.get(agent) === agent.prompt
    )
      return [...provider, agent.prompt!, guidance]
    return agent.prompt ? [agent.prompt] : provider
  }
}
