# Routine tool permissions

New routines default to `brief`, shown as **Read and report**. The runtime starts with a deny-all permission rule and permits built-in reading, file search, skill reading, questions, conversation todo tracking, and the active goal's inspection/update tools. Unknown permission categories are denied. Shell commands, edits, browser actions, delegation and service-specific mutation permissions are not included.

A saved tool list can narrow this profile. Wildcards and explicit mutation names cannot expand it. The permission ceiling is attached when the routine creates its session; changing a routine definition affects future sessions, not an already-running session. Existing sessions must be stopped and restarted to receive the new ceiling.

**Full tool access** retains the existing broad permission policy, optionally narrowed by a saved tool list. It can authorize external tools and delegated work as well as workspace edits. The access review describes that scope rather than calling it workspace editing alone. Persona names and money/message consent records do not themselves enforce a filesystem or service boundary.

These are application permission rules, not operating-system confinement. Built-in MCP resource readers share the `read` permission and may read external resource data. Installed plugin code remains trusted host code; a plugin that performs side effects without asking for the appropriate permission is outside this policy's enforcement boundary. A requested strict sandbox must still fail closed on unsupported platforms. When a write folder is saved, future full-access sessions keep file-tool edits inside that folder: parent-folder write patterns are denied. Reading other locations remains allowed. Shell and plugins are not confined by the write folder.

Connected-service review enumerates the exact tool keys currently exposed by each connected MCP service. Saving a service grants those exact keys, not a blanket `mcp_*` pattern; tools added later require another review, and disconnected services are not offered. Existing exact or partial saved keys remain reviewable. The catalog is bounded and discloses truncation. Live permission escalation receipts, readable/multiple-writable path scopes, shell confinement, trusted-plugin enforcement and complete browser/delegation acceptance remain unfinished audit requirements.

Verification must cover both the routine rules and the real tool dispatch boundary. Rule-level assertions alone do not establish that every plugin or external integration follows the permission contract.
