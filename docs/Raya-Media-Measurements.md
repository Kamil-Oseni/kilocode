# Raya media transport measurements

ChatGPT, 2026-09-28 23:34 EDT. The first native latency measurement passed; the sustained resource diagnostic failed and prolonged resource acceptance remains unproven.

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
gh workflow run raya-media.yml --repo Kamil-Oseni/kilocode --ref main -f resource_seconds=1800
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
