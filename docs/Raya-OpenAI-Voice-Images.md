# Selected images in OpenAI voice

Users can choose an image, inspect the resized preview, and explicitly share it with the active OpenAI voice conversation. Sharing does not start workspace work or request a spoken response. A subsequent request can use the image through the existing `raya_work` tool and normal parent conversation permissions.

The picker accepts PNG, JPEG and WebP files up to 8 MiB. It decodes and resizes the selected file to a JPEG with a longest side of at most 1,600 pixels and at most 256 KiB. The preview shows the version being shared. This is deliberate file sharing; it does not capture the screen, camera or video continuously.

## Ownership and delivery

The trusted extension host stages each image against the active backend voice binding using its capability, generation and directory. The backend validates canonical base64, the declared format's signature and decoded size, and returns the image ID, MIME type, byte count and SHA-256 digest. An ID cannot be reused with different content. Each binding holds at most eight images; one work request may reference at most four distinct IDs from that binding.

After checking that receipt and the still-current connection, the host sends a Realtime `conversation.item.create` message containing the image and its reference ID. The UI shows Shared only after the matching `conversation.item.created` acknowledgement. A rejection correlated to that exact image event is reported separately from voice failure. Connection loss or acknowledgement timeout remains unconfirmed and does not trigger automatic replay. Duplicate requests with the same ID reuse the retained outcome.

The backend resolves work image IDs into actual file parts in the parent prompt and records image metadata in the work receipt. The model receives image bytes rather than an invented textual description. Choosing or staging an image alone does not admit a work call.

## Retention and limits

Shared images are sent to OpenAI and retained in the local voice binding. Images used for work also become part of the normal parent conversation. Ending voice does not delete these records or cancel already-admitted work. This change does not introduce an image deletion or retention-period policy.

The provider integration follows OpenAI's [Realtime image-input event documentation](https://developers.openai.com/api/docs/guides/realtime-conversations). The selected [gpt-realtime-2.1 model](https://developers.openai.com/api/docs/models/gpt-realtime-2.1) supports image input; this implementation does not claim video support. Local transport and browser tests cannot establish live account access, provider acceptance or device latency. Those remain separate acceptance work.

## Verification

The actual host broker is exercised through loopback HTTP and WebSocket transports, including staging credentials and binding, exact acknowledgement, explicit work references, scoped rejection, disconnection, invalid formats and mismatched storage receipts. Backend and rendered-picker evidence is recorded with the coordinated checkpoint in the implementation progress document.
