# Explicit native voice recovery

After a native voice call ends or fails, Raya offers **Restart voice in this task**. This creates a fresh call in the same parent task; it does not resume the previous provider connection. The action remains a direct user gesture so microphone capture is deliberate.

The pre-start disclosure explains that starting voice shares recent saved task context with OpenAI and that unsaved spoken context may be missing. The recovery panel repeats the fresh-call limitation and explains that already-started work continues in the conversation. Host context loading and acknowledgement happen before readiness; the webview neither assembles authoritative history nor replays work.

## Cleanup ownership

One reactive recovery record replaces the former nonreactive set of closing request IDs. A new native call cannot start until both conditions hold:

- Local microphone/audio cleanup resolved successfully.
- The host returned `speechOpenAIStopped` for the exact ended request.

Either completion order is supported. An unrelated or old acknowledgement cannot enable restart, and a host acknowledgement cannot bypass pending or failed local cleanup. Closing state is established before sending the host stop request. Repeated stop calls do not launch overlapping local cleanup attempts.

Unconfirmed host cleanup or failed local cleanup leaves admission blocked and shows a recovery instruction. It does not automatically retry, allocate another provider call, submit transcript text, or cancel parent work. A successful cleanup enables the button reactively but never clicks it or starts capture.

Navigating to another task permanently invalidates the old restart offer, including after navigating back. Cleanup ownership remains in force across navigation, so switching tasks cannot bypass an unresolved release. Changing voice engines also invalidates the offer. Explicitly starting a later call uses a fresh request identity and clears the previous call's transcript/image selection through the existing lifecycle.

## Scope and verification

This is explicit fresh-call recovery with saved parent-task context. It does not provide ICE restart, automatic reconnection, a recovered provider session, a rolling voice snapshot, or the architecture document's warm handoff. Spoken material that was not persisted as normal parent work remains unavailable. Existing parent work stays inspectable in chat.

The focused production-state fixture passed 22 assertions covering host-first and local-first cleanup, unrelated acknowledgements, failure blocking, duplicate stop calls, and task invalidation. The actual VoiceProvider fixture passed 41 assertions, including a synchronous host acknowledgement during stop, admission before native media starts, reactive enablement, no automatic retry, and new-call identities. Together their two unit wrappers exited successfully. Scoped ESLint also passed.

The actual composer recovery fixture passed at 360-pixel width in light and dark themes. It verified the disclosure, disabled/enabled restart states, cleanup failures, task navigation, preserved work, and no horizontal overflow. The existing transcript/usage composer fixture also passed both themes through the new explicit restart action. Screenshots `.tmp/native-recovery-ready-light.png`, `.tmp/native-recovery-ready-dark.png`, `.tmp/native-recovery-blocked-light.png`, and `.tmp/native-recovery-blocked-dark.png` were retained and visually inspected. The composer fixtures substitute media boundaries; they do not establish paid-provider behavior or acoustic reconnection continuity.
