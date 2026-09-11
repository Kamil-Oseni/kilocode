# OpenAI voice default

Unconfigured voice now defaults to OpenAI GPT-Live 1 (`gpt-live-1`) over the Live API. Opening settings or loading the default does not start a call, microphone capture or provider request. The user must explicitly start voice and supply its dedicated OpenAI API key.

## Saved settings

All valid saved engine values are preserved: `openai-live`, `openai-realtime`, `qwen-realtime` and `cascade-v1`. Absent or invalid engine values adopt the GPT-Live default. Unrelated settings edits and secret changes retain the selected engine and existing off mode. Loading settings does not rewrite storage.

Earlier versions saved OpenAI Realtime as the default. There is no reliable record distinguishing an old implicit Realtime default from a deliberate Realtime selection. This change therefore preserves every valid stored Realtime value; it does not infer intent or migrate those users automatically. Users can select GPT-Live 1 in Speech settings when ready.

## Credentials and recovery

Missing-key guidance appears in Speech settings. The provider blocks missing OpenAI credentials before entering native microphone transport, and the trusted host independently checks the dedicated secret before call admission. Legacy voice, transcription and synthesis keys are not borrowed. OpenAI failures do not silently switch providers. Saving or clearing a key does not start recording. OpenAI credentials remain in VS Code Secret Storage and are excluded from the optional CLI speech mirror.

GPT-Live uses `POST /v1/live/sessions` with client delegation. Realtime remains an explicit compatibility engine (`gpt-realtime-2.1`). Images still go to Raya work and its vision model, not GPT-Live.

## Scope and verification

This is a default and setup change, not proof of live account/model access, microphone permissions, echo cancellation quality or latency on a user's device. It does not itself add screen/camera input, device selection, or new voice controls. Those capabilities must retain their own implementation and validation evidence.

Tests exercise the real settings normalizer/store, actual VoiceProvider loading and missing-key admission, and rendered SpeechTab key/save/clear and legacy selection states. Packaged microphone and acoustic acceptance remain separate.
