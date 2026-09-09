# Auto tool-call recovery

Auto must not infer broader authority from a failed tool call. Unknown tool names and invalid arguments do not authorize delegation, filesystem changes, or routing a different request.

The AI SDK path now returns the original tool error for an invalid Auto call. The model can correct its call using the available tools and original user constraints. Recovery does not manufacture a task prompt, select a write-capable specialist, or invent missing route/task arguments. Existing whitespace/case normalization of an available tool name retains the supplied arguments and remains supported.

## Verified behavior

A local HTTP provider fixture exercises the actual LLM streaming service with Auto, available route/task tools, and a read-only request that prohibits delegation. Unknown read/write/nonexistent calls and malformed task/chief_route calls each produce a tool error for the original call. No task or route handler executes, no tool result is reported, and the fixture proves every request reached the local provider. The existing whitespace-padded tool-name execution regression also passes.

The Chief routing fixture suite remains green. That suite is a regression corpus, not held-out evidence that Auto outperforms a generalist.

## Remaining audit work

This removes automatic escalation during tool-call repair. It does not enforce a complete inherited authority envelope across all explicit delegations, redesign Auto's route/task workflow, evaluate model-selection quality, or add bounded rerouting after outages. Native-runtime behavior and broader provider coverage need their own acceptance tests; this change targets the AI SDK recovery branch that contained the confirmed escalation.
