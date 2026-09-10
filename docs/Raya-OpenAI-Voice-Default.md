# OpenAI voice default

Unconfigured voice now defaults to OpenAI Realtime using the existing `gpt-realtime-2.1` integration. Opening settings or loading the default does not start a call, microphone capture or provider request. The user must explicitly start voice and supply its dedicated OpenAI API key.

## Saved settings

All valid saved engine values are preserved: `openai-realtime`, `qwen-realtime` and `cascade-v1`. Absent or invalid engine values adopt the new default. Unrelated settings edits and secret changes retain the selected engine and existing off mode. Loading settings does not rewrite storage.

Earlier versions saved normalized settings, including their Qwen default. There is no reliable record distinguishing an old implicit default from a deliberate Qwen selection. This change therefore preserves every valid stored Qwen value; it does not infer intent or migrate those users automatically. Users can select OpenAI in Speech settings when ready.

## Credentials and recovery

Missing-key guidance appears in Speech settings. The provider blocks missing OpenAI credentials before entering native microphone transport, and the trusted host independently checks the dedicated secret before call admission. Legacy voice, transcription and synthesis keys are not borrowed. OpenAI failures do not silently switch providers. Saving or clearing a key does not start recording. OpenAI credentials remain in VS Code Secret Storage and are excluded from the optional CLI speech mirror.

## Scope and verification

This is a default and setup change, not proof of live account/model access, microphone permissions, echo cancellation quality or latency on a user's device. It does not itself add screen/camera input, device selection, or new voice controls. Those capabilities must retain their own implementation and validation evidence. The existing preview label and device-validation guidance remain.

Tests exercise the real settings normalizer/store, actual VoiceProvider loading and missing-key admission, and rendered SpeechTab key/save/clear and legacy selection states. The final focused batch passed nine tests with 76 Bun assertions in 4.91 seconds (native exit 0), including child fixtures with 33 actual VoiceProvider assertions and 15 actual SpeechTab/store assertions. Scoped ESLint passed with native exit 0. Logs: `.tmp/openai-default-tests-final.log` and `.tmp/openai-default-lint.log`. The initial `.tmp/openai-default-tests.log` retains a fixture-only failure: the broad story wrapper imported an unrelated diff custom element unavailable in the headless DOM. The final fixture uses the actual VS Code, session and voice providers required by SpeechTab. Coordinated package types remain a checkpoint gate.
