# Raya media transport measurements

ChatGPT, 2026-09-28 23:20 EDT. Measurement implementation is pending native execution; no latency or prolonged resource result is claimed here.

## Reproducible environment

The `Raya media conformance` workflow builds the production CGO executable from the exact commit using the service Dockerfile and starts the pinned loopback-only LiveKit test SFU. Record the workflow run/job, source commit, build-image digest and binary SHA-256 with every result. These are synthetic local transport tests with no microphone, speaker, paid provider or installed desktop host. They do not measure model inference, Internet travel, browser capture, remote playback or a user's completed task.

The normal push gate runs a 60-second resource diagnostic. For prolonged measurement, dispatch the same workflow on the reviewed commit with `resource_seconds=1800`. The dedicated test container has a 2 GiB memory cap and 256-process/thread cap. These are declared test-environment budgets, not configured production service limits. The separate SFU is outside that container and outside the measured parent/child aggregate.

```powershell
gh workflow run raya-media.yml --ref main -f resource_seconds=1800
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
