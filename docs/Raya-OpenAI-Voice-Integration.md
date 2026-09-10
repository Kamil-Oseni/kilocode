# OpenAI voice integration checkpoint

OpenAI Realtime is an explicit preview choice in Speech settings. The existing selected engine is preserved. The audit's default-switch gate remains open until account access and packaged microphone acceptance pass. Choose **OpenAI Realtime (preview)**, save its separate API key, and start voice from an existing task. Changing the engine ends the current call without starting another or recording audio.

The selected target is `gpt-realtime-2.1`, with `marin` as the initial voice. This implements OpenAI's documented API architecture, not a claim of reproducing every ChatGPT voice feature. The model and account still need a live access probe. See the [official model documentation](https://developers.openai.com/api/docs/models/gpt-realtime-2.1).

## Connection and authority

The browser captures microphone audio and creates a native WebRTC offer. The extension sends the offer and session configuration to OpenAI's unified calls endpoint using its Secret Storage key, validates the returned call identity, binds the call to the current Raya task, and establishes an authenticated server-control WebSocket. The webview receives only the correlated SDP answer. It receives neither the OpenAI key nor the backend capability. This follows the [WebRTC guide](https://developers.openai.com/api/docs/guides/realtime-webrtc) and [server-control guide](https://developers.openai.com/api/docs/guides/realtime-server-controls).

The host enables one `raya_work` function after the existing-session binding is confirmed. It dispatches only completed function items in a completed response; partial arguments and canceled responses cannot launch work. The bounded queue serializes distinct calls through the backend's one-pending-work admission rule. Repeated call IDs do not replay work. Results must match the captured parent session, call and reserved message identity before becoming function outputs. Permission questions and work receipts remain in the ordinary Raya conversation.

Backend generation, client, tracked task and workspace are captured at start. Invalidating that scope closes voice and refuses new work. End voice, transport failure and scope changes close audio and new admission while preserving work already admitted to the parent conversation. An uncertain provider start, binding acknowledgment or cleanup retains ownership and requires restart/reconciliation rather than automatic retry. See [backend authority](Raya-OpenAI-Voice-Backend.md) and [browser transport](Raya-OpenAI-Browser-Voice.md).

Input captions use OpenAI's `gpt-live-transcribe` low-delay transcription configuration. Captions are a separate display of recognized audio, not an authoritative work request or proof of what the realtime model heard. WebRTC handles audio interruption; the browser does not invent a second STT/TTS interruption pipeline. See [transcription](https://developers.openai.com/api/docs/guides/realtime-transcription) and [conversation events](https://developers.openai.com/api/docs/guides/realtime-conversations).

## Credentials and recovery

- The OpenAI key has its own Secret Storage entry. Qwen, STT and TTS keys are never borrowed for it.
- Public settings contain only a presence flag. The optional plaintext CLI speech mirror deliberately excludes the OpenAI key.
- OpenAI failures do not select Qwen or MiniMax. Selecting an alternative is explicit.
- Missing keys are reported before microphone capture. Late SDP and legacy-provider replies cannot revive a stopped call or bypass pending cleanup.
- Tool failures and unknown receipts are visible; the broker never retries a mutation to recover a spoken response.
- Ending voice does not roll back completed file operations or cancel admitted work. Use the conversation's work controls to stop that work.

## Evidence and remaining work

The coordinated checks cover real Storage/Runner/TaskWorker behavior and HTTP routes; the actual host broker over local HTTP/WebSocket servers; actual Chromium WebRTC peers with synthetic audio; and actual VoiceProvider state/bridge behavior. These are local acceptance fixtures, not a paid OpenAI session or real microphone test. Fixture corrections and exact counts are retained in the implementation progress log.

The remaining OVR-01 work includes a live account probe, packaged extension microphone and playback, acoustic echo cancellation and interruption measurements, device switching and mute, selected-image sharing, spoken question/goal handoff, realtime usage and cost attribution, visible work state, latency evaluation, and default-rollout acceptance. No successful package installation alone closes these gates. Keep OpenAI preview selected only deliberately until those checks are complete; selecting the legacy engine provides the migration rollback without moving or copying credentials.
