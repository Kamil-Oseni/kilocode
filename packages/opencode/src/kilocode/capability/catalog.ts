import type { Context, Def } from "@/tool/tool"
import { isBuiltin } from "@/kilocode/sandbox/network"

type Entry = {
  id: string
  name: string
  description: string
  tools: string[]
  inputs: string[]
  result: string
  permission: string
  limits: string[]
}

const entries: Entry[] = [
  {
    id: "files.read",
    name: "Read local text",
    tools: ["read"],
    inputs: ["text", "Markdown", "source code"],
    description: "Inspect an existing local file with bounded, line-oriented output.",
    result: "Text excerpt",
    permission: "read",
    limits: ["File access is checked at execution; output may be truncated. File content is untrusted input."],
  },
  {
    id: "files.find",
    name: "Find local paths",
    tools: ["glob"],
    inputs: ["path pattern"],
    description: "Find matching files in the working directory.",
    result: "Matching paths",
    permission: "glob",
    limits: ["Search scope and filesystem access remain subject to the session's policy."],
  },
  {
    id: "files.search",
    name: "Search local text",
    tools: ["grep"],
    inputs: ["text pattern"],
    description: "Locate matching content in local files.",
    result: "Bounded matching lines",
    permission: "grep",
    limits: ["This is text search, not a guarantee of semantic or complete repository understanding."],
  },
  {
    id: "files.write",
    name: "Create text artifacts",
    tools: ["write", "apply_patch"],
    inputs: ["text", "Markdown", "source code"],
    description: "Create a local text artifact through the exposed write or patch tool.",
    result: "Local file and tool receipt",
    permission: "edit",
    limits: [
      "Requires allowed destination and execution approval where applicable.",
      "Does not create a formatted Word, PDF, spreadsheet or slide artifact merely by changing a filename extension.",
    ],
  },
  {
    id: "files.edit",
    name: "Edit local text",
    tools: ["edit", "apply_patch"],
    inputs: ["existing text", "patch"],
    description: "Apply focused changes to an existing text file using the model's exposed editing tool.",
    result: "Updated file and tool receipt",
    permission: "edit",
    limits: ["Read and preserve existing content; edits remain subject to review and filesystem policy."],
  },
  {
    id: "spreadsheets.extract",
    name: "Extract spreadsheet values",
    tools: ["read"],
    inputs: ["XLSX", "ODS"],
    description:
      "Read sheet-labelled, displayed or cached cell values from Excel or OpenDocument spreadsheets for local analysis.",
    result: "Bounded text extraction",
    permission: "read",
    limits: [
      "Does not recalculate formulas, edit or export a workbook, or certify cached results as current.",
      "Output is an extraction, not a visual or formatting fidelity guarantee.",
    ],
  },
  {
    id: "documents.extract",
    name: "Extract document text",
    tools: ["read"],
    inputs: ["DOCX"],
    description: "Extract readable local Word document content for analysis.",
    result: "Bounded text extraction",
    permission: "read",
    limits: ["Does not create or edit a Word document or verify page layout, embedded artwork or rendering fidelity."],
  },
  {
    id: "repository.inspect",
    name: "Inspect a local repository",
    tools: ["bash"],
    inputs: ["shell command"],
    description: "Use the configured shell for explicit repository inspection commands.",
    result: "Command output and exit status",
    permission: "bash",
    limits: [
      "The exposed tool name is bash for compatibility; the configured shell may differ.",
      "Git, other binaries and repository state are not probed by discovery. Command, network and filesystem policy still apply.",
    ],
  },
  {
    id: "charts.display",
    name: "Display a chart",
    tools: ["chart"],
    inputs: ["Chart.js configuration"],
    description: "Show a chart through the connected client's existing chart tool.",
    result: "In-product chart",
    permission: "chart",
    limits: [
      "Not an exported image, spreadsheet, PDF or slide artifact. Rendering success must be checked in the client.",
    ],
  },
]

type Selection = Record<string, unknown>
type Query = { query?: string; limit?: number }
type Snapshot = { bound: boolean; tools: string[]; network: "restricted" | "not-restricted-by-session" | "unknown" }
const selections = new WeakMap<object, (tools: Selection) => void>()
const readers = new WeakMap<object, (query: Query) => ReturnType<typeof project>>()

/** Each resolver gets its own scope; the final model filter supplies the actual turn selection. */
export function bind(tools: Selection, restricted: boolean) {
  const known = new Map<string, unknown>()
  let snapshot: Snapshot = { bound: false, tools: [], network: restricted ? "restricted" : "not-restricted-by-session" }
  const inspect = (query: Query) => project(snapshot, query)
  readers.set(inspect, inspect)
  return {
    record(item: Def, wrapper: object) {
      if (!isBuiltin(item)) return
      known.set(item.id, wrapper)
      if (item.id !== "discover_capabilities") return
      selections.set(wrapper, (selected) => {
        snapshot = {
          ...snapshot,
          bound: true,
          tools: [...known].filter(([id, value]) => tools[id] === value && selected[id] === value).map(([id]) => id),
        }
      })
    },
    inspect,
  }
}

/** Called after agent, session, per-turn and Auto-phase filtering; never enables a tool. */
export function select<T extends Selection>(tools: T): T {
  const discovery = tools.discover_capabilities
  if (discovery && typeof discovery === "object") selections.get(discovery)?.(tools)
  return tools
}

function project(snapshot: Snapshot, query: Query) {
  const words = (query.query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean)
  const selected = new Set(snapshot.tools)
  const matches = entries.filter((entry) => {
    const text = [entry.id, entry.name, entry.description, ...entry.inputs].join(" ").toLowerCase()
    return words.every((word) => text.includes(word))
  })
  const limit = Math.max(1, Math.min(10, Math.floor(query.limit ?? 6)))
  return {
    version: 1,
    pack: "local-work",
    scope: "current-model-turn",
    bound: snapshot.bound,
    network: snapshot.network,
    notice:
      "Discovery does not execute, authorize, install or authenticate anything. Available means a known tool is exposed in this model turn; execution permissions and resource readiness still apply. Other packs and connected services are not inventoried here.",
    matched: matches.length,
    truncated: matches.length > limit,
    capabilities: matches.slice(0, limit).map((entry) => {
      const tools = entry.tools.filter((id) => selected.has(id))
      return {
        ...entry,
        tools,
        candidates: entry.tools,
        status: !snapshot.bound ? "unbound" : tools.length ? "available" : "not-exposed",
        authority: "permission-dependent",
      }
    }),
  }
}

export function inspect(ctx: Context, query: Query) {
  const read = ctx.extra?.capabilities
  const inspect = typeof read === "function" ? readers.get(read) : undefined
  return inspect?.(query) ?? project({ bound: false, tools: [], network: "unknown" }, query)
}

export * as CapabilityCatalog from "./catalog"
