# Confirming goal tracking before sending work

An explicit `/goal` command, or a request recognized by the existing durable-goal parser, must receive a matching saved-goal response before the extension sends the task to the model. The server's create endpoint already creates, archives completed goals or steers an existing goal as appropriate.

The extension no longer responds to every create failure by issuing an unrelated update and then falling back to ordinary chat. It sends one create request with the original message/session/directory identity and a 30-second response deadline. It validates the returned objective, intent, live status, timestamps, counters and progress shape. A replaced connection, changed or ambiguous session directory, failed request or mismatched response stops prompt dispatch.

The existing send-failure reply retains the submitted text, attachments and draft/message identity. Its recovery message asks the user to review the saved goal before retrying: a failed or timed-out response does **not** prove the server did not save the goal. There is no automatic fallback mutation or replay. Ordinary messages that are not goal requests retain their existing send path.

## Evidence and limits

`tests/unit/goal-start.test.ts` executes the production send method extracted from `KiloProvider.ts`, supplying editor/session adapters without starting VS Code. Goal and prompt requests use the generated SDK and an actual loopback HTTP server. It covers success with attachments and model selection, HTTP failure, malformed/mismatched/completed responses, replacement during creation, replacement after confirmation, ordinary chat and disconnection. Assertions check request order, absence of fallback PATCH or prompt on unconfirmed outcomes, and recovery payload identity.

This is transport/send-boundary evidence, not a full extension-host test or proof of server transaction durability. Existing backend goal creation/steering rules remain unchanged. Uncertain mutation reconciliation, concurrent objective changes after confirmation, and end-to-end draft recovery remain broader goal-lifecycle work.
