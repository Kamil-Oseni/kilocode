# Raya media transport measurements

## ChatGPT 2026-09-28 23:55 EDT - separate continuous-worker resource acceptance

A read-only acceptance audit found that the existing prolonged test replaces every native child after thirty seconds. Its active run `36518672345` / job `109246562775` on `b98257e36a` measures a long-lived parent with repeated short-lived children, not one thirty-minute child. It remains live in the sustained-resource step; preserve this exact run to terminal completion.

Added explicit `churn` and `continuous` resource modes, with default push diagnostics retaining churn and manual dispatch offering continuous. Continuous keeps the same native child for the configured interval starting at confirmed readiness, then requires actual Wait and PID absence. Additive version-1 reports include mode, per-child ready/active seconds and aggregate active seconds. The workflow matches requested mode/duration, native latency/resource binary identity, stable parent and exact observed/retired child identities, sample ordering, slot/child counts, PSS sums and genuine retirement receipts. Mode-specific checks require exactly one full-duration child for continuous or repeated distinct children for churn. Invalid mode spelling/whitespace is refused before expensive setup.

The complete local CGO-zero suite passes, including the actual portable mode parser's valid/invalid cases; Go formatting, YAML formatting, workflow/upstream annotation checks and both Python verifier syntax checks pass. These local checks do not compile or execute the Linux CGO lifecycle changes. No continuous-worker native acceptance result exists yet. Stage/commit this slice locally, but defer its push until the existing churn benchmark is terminal: the workflow's cancel-in-progress policy would cancel the live experiment on a service/workflow push. Then push, inspect the fresh diagnostic gate, dispatch `resource_seconds=1800` with `resource_mode=continuous`, and retain its terminal evidence. Neither mode proves prolonged eight-worker load, expected 50 Hz delivery, physical device/provider playback, or a universal memory plateau. Full requirements remain In progress; desktop stopped and installed snapshot unchanged.

ChatGPT, 2026-09-28 23:48 EDT. The fresh complete native gate and 60-second diagnostic passed. The 30-minute resource benchmark is active; prolonged resource acceptance remains unproven.

## ChatGPT 2026-09-28 23:48 EDT - native diagnostic gate passed; prolonged run active

Source `b98257e36a` [run 36518270683](https://github.com/Kamil-Oseni/kilocode/actions/runs/36518270683), job `109245332808`, completed successfully: production CGO/full suite, actual SFU conformance and latency, 60-second resource diagnostic, CGO vet and production image smoke all passed. Evidence is retained in `.tmp/media-measurement-36518270683/` and the workflow artifact. Binary SHA-256: `3740271906d91eb96f4525c13c95254974c89de81c04c7d6723b404492f8d79f`; build image: `sha256:f618e75e186496fe870861a707e106ff207f550a4a9bed4c8a4120a5fbe22c9a`.

All ten latency sessions/fifty exact nonce deliveries completed. Warm ACK p50/p95: 0.165/0.210 ms; independent warm client arrival: 0.308/0.368 ms; repeated join readiness: 53.521/55.376 ms; Close to actual Done: 1.621/3.354 ms. These small-sample local measurements exclude provider, device, playback and UI. The diagnostic completed 60.021 seconds, two actual child retirements, 64 process observations, 2,985 nonzero decoded input frames, 2,991 received Opus packets and 58 exact control deliveries. Active owned PSS p50/max: 95,712/166,888 KiB; final owned slots: zero. Effective cgroup limits were 2 GiB/256 process-threads with zero OOM events. The diagnostic has no post-warmup window and proves no memory plateau. Its success after the padding correction does not independently establish the earlier exit's cause.

The explicit 1,800-second benchmark is now active: [run 36518672345](https://github.com/Kamil-Oseni/kilocode/actions/runs/36518672345), job `109246562775`, exact source `b98257e36ac0baf2dd41f2203e5a91897ac5fcce`. Next inspect this same run to terminal completion, preserve its raw artifact and report warmed/final resource windows and every actual retirement. Do not restart it after observation timeout or claim prolonged acceptance before it passes. Full voice/OVR-01/EN-05/FUT-CU-01 remain In progress. Installed snapshot unchanged; media service undeployed, desktop stopped, MCP deferred and user/French Study changes preserved.

## First native result

Source `8443f15b9a`, [run 36517294759](https://github.com/Kamil-Oseni/kilocode/actions/runs/36517294759), job `109242334610`, passed production CGO build/full suite and the native conformance/latency step. Binary SHA-256: `482eb64e17f8fd4b2500f9a46b57c33dbc24940ed4642fb052a6bdb45d52bb12`. All ten sessions and fifty exact nonce deliveries completed without retry. Raw evidence is retained in `.tmp/media-measurement-36517294759/native-conformance.log` and the workflow artifact.

| Metric | Count | p50 ms | p95 ms | Max ms |
|---|---|---|---|---|
| Repeated join readiness | 10 | 50.665 | 1133.411 | 1133.411 |
| First control ACK | 10 | 0.362 | 0.858 | 0.858 |
| First exact client arrival | 10 | 0.573 | 1.034 | 1.034 |
| Warm control ACK | 40 | 0.130 | 0.197 | 0.368 |
| Warm exact client arrival | 40 | 0.236 | 0.353 | 0.687 |
| Close to actual Done | 10 | 1.966 | 41.019 | 41.019 |

The same run failed its 60-second resource diagnostic after 1.093 measured seconds: the accepted child disappeared before the first process-resource sample. The partial report preserves zero samples and a failed outcome. Vet and production image smoke were skipped after that failure, so this is not a complete successful gate. Native startup-fault diagnosis is the next action; the 30-minute run has not started. These small-sample local timings support no provider, playback, installed-host or comparative-product claim.

ChatGPT, 2026-09-28 23:41 EDT: bounded startup diagnostics now retain sanitized operation/error/frame-shape counts for at most sixteen genuine private wire messages. Independent actual UDP/Pion receiver tests established that legitimate padding-only packets were incorrectly rejected; the correction advances their sequence without producing codec data. Padding is excluded from the RTP payload by [RFC 3550 section 5.1](https://www.rfc-editor.org/rfc/rfc3550.html#section-5.1). Local receiver/full Go tests and vet pass, but the failed native diagnostic's exact cause remains unproven until a fresh native run. Invalid empty and oversized packets remain refused.

## Reproducible environment

The `Raya media conformance` workflow builds the production CGO executable from the exact commit using the service Dockerfile and starts the pinned loopback-only LiveKit test SFU. Record the workflow run/job, source commit, build-image digest and binary SHA-256 with every result. These are synthetic local transport tests with no microphone, speaker, paid provider or installed desktop host. They do not measure model inference, Internet travel, browser capture, remote playback or a user's completed task.

The normal push gate runs a 60-second resource diagnostic. For prolonged measurement, dispatch the same workflow on the reviewed commit with `resource_seconds=1800`. The dedicated test container has a 2 GiB memory cap and 256-process/thread cap. These are declared test-environment budgets, not configured production service limits. The separate SFU is outside that container and outside the measured parent/child aggregate.

```powershell
gh workflow run raya-media.yml --repo Kamil-Oseni/kilocode --ref main -f resource_seconds=1800 -f resource_mode=continuous
```

Do not start a second run merely because observation times out. Inspect the original run's authoritative status. The workflow retains measurement logs for 30 days, including failures; save evidence needed for longer-term acceptance separately. A skipped, missing, failed or cancelled test is not a passing result.

## Latency boundaries

`TestProductionWorkerActualSFULatencySamples` uses ten fresh production children with independent real SDK observers and five single-attempt exact nonce deliveries per child. Raw samples and nearest-rank p50/p95/max distributions are emitted as versioned JSON with milliseconds and binary identity.

| Metric | Start | End | Interpretation |
|---|---|---|---|
| `join_ready` | Before Factory join | Owned readiness returned | Process launch and native SFU readiness; observer setup excluded |
| `first_send_ack` / `warm_send_ack` | Before Send | Confirmed native action ACK | Local request/IPC/native submission; independent of recipient arrival |
| `first_client_arrival` / `warm_client_arrival` | Before the same Send | Exact independent SDK nonce callback | Loopback SFU control delivery; no media playback claim |
| `close_actual_done` | Before Close | Actual process Wait and joined pipe owners | Local retirement; PID absence checked independently |

“Fresh process” does not mean cold OS caches. Page-cache state is uncontrolled and explicitly recorded. Ten first-action and forty warm-action samples describe this run; they are insufficient for strong tail-performance conclusions. Missing, mismatched, refused or timed-out trials fail instead of being retried or excluded to improve statistics. There is no speed-superiority gate and no zero-latency claim.

## Resource evidence and acceptance limits

The dedicated Linux test records the configured and measured duration, raw timestamped process observations, parent and owned-child identities, PSS/RSS, thread/file-descriptor counts, owned worker count and available cgroup limits/events. Exact process start time fences PID reuse. Actual process Wait and PID disappearance are required for retirement; a Close return or a delay alone is insufficient. Starting/running/retiring workers remain subject to the existing eight-owner capacity.

Report initial, warmed, window and final measurements separately. PSS is the preferred additive physical-memory estimate; summed RSS can count shared pages repeatedly. A finite window can demonstrate observed drift or a leak; it cannot establish an allocator plateau for all workloads. Compiler processes and SFU memory are not included in a parent/owned-child PSS total. Cgroup observations describe the entire dedicated test container and must not be mislabeled as that narrower aggregate.

A successful 30-minute synthetic run proves only its recorded transport workload, resource budgets and retirement checks. Full-duplex browser/device use, provider cost settlement, installed Windows restart/disconnect/manual takeover and longer varied workloads remain separate release gates. The overall voice and desktop requirements stay In progress until those gates pass.
