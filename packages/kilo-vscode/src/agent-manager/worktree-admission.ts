const mutations = new Set([
  "agentManager.createWorktree",
  "agentManager.deleteWorktree",
  "agentManager.removeStaleWorktree",
  "agentManager.promoteSession",
  "agentManager.addSessionToWorktree",
  "agentManager.forkSession",
  "agentManager.closeSession",
])

/** Only these awaited lifecycle actions own their complete message continuation. */
export function admitWorktreeMessage<T>(
  msg: Record<string, unknown>,
  body: () => Promise<T>,
  admit: (body: () => Promise<T>) => Promise<T>,
): Promise<T> {
  return typeof msg.type === "string" && mutations.has(msg.type) ? admit(body) : body()
}
