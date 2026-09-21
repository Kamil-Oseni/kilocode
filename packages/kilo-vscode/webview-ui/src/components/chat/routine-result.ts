const ORGANIZATION = /^org_[a-f0-9]{32}$/
const AGENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function field(value: unknown) {
  if (typeof value !== "string" || !value) return
  return value
}

export function routineTitle(tool: string) {
  if (tool === "schedule_task") return "Create routine"
  if (tool === "create_organization") return "Create organization"
  if (tool === "update_organization") return "Update organization"
  return "Update routine"
}

export function routineAction(tool: string) {
  if (tool === "create_organization" || tool === "update_organization") return "View organization"
  return "View routine"
}

export function routineDestination(metadata: Record<string, unknown>) {
  const organizationID = field(metadata.organizationID)
  const agentID = field(metadata.agentID)
  if (organizationID && !ORGANIZATION.test(organizationID)) return
  if (agentID && !AGENT.test(agentID)) return
  if (!organizationID && !agentID) return
  return { organizationID, agentID }
}

export function routineTarget(status: string | undefined, metadata: Record<string, unknown>) {
  if (status !== "completed" || metadata.view !== "routines") return
  return routineDestination(metadata)
}
