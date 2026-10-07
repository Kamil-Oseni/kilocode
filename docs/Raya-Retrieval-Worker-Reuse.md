# Bounded retrieval worker reuse

The requested endpoint is a reusable CPU retrieval worker with a bounded queue, idle expiry, cancellation, and observed process retirement. A cache inside the current finite worker does not reach that endpoint: `owner.py` joins the process and all original streams before version 1 accepts a result, and `bootstrap.py` consumes one EOF-terminated payload.

## Protocol component implemented

`script/memory/retrieval/lease.py` provides a separate version 2 length-prefixed frame codec and lease request gate. Frames have strict byte bounds and duplicate/nonfinite JSON refusal. A request binds the lease nonce, owner epoch, selected release hash, model/kind, request body hash and monotonic sequence. One request can be active; request identities cannot replay; a lease admits at most 32 requests. Completion snapshots the admitted identity instead of accepting mutable caller metadata.

The completion frame is not a retirement receipt. It deliberately contains no claim that process or streams have joined. Five maintained tests cover framing, invalid selections, body changes, replay, capacity, and one active request. They exercise the actual codec/state implementation without model or native-process substitutes. They do not prove worker reuse or native ownership.

`script/memory/retrieval/resident.py` now supplies the sequential loop and selected-model residency implementation. It validates bounded inputs before importing model dependencies, loads its fixed CPU model on the first valid request, retains that object for later calls, and uses the existing result validator before emitting completion. It refuses model/kind changes within a lease and has no executor or secondary inference queue. EOF and the request cap return from the loop; malformed frames, invalid inputs and inference errors propagate to the bootstrap so the parent must retire the lease. Parent-controlled idle expiry, cancellation and deadlines are still required.

Five additional tests exercise actual empty-input, selection-mismatch, invalid-input and framed-failure paths without loading a model or substituting an inference implementation. All ten protocol/resident tests pass. They do not prove repeated inference, model-memory release or native retirement. A live model test was deferred after observing about 8.6 GiB of free RAM: the prior approximately 3 GiB model peak would leave insufficient margin for the 6 GiB reserve. No model was loaded for these tests.

These modules are not selected by the current protected release or imported by the running service. Version 1 remains unchanged. The full implementation is still required; these components must not be deployed as a completed reuse feature.

## Native completion observation implemented

`retrieval/living.py` checks the caller's retained original process and job handles without finding or adopting a PID. It requires a running process, the captured creation time and executable image, membership in the original job, and unchanged authenticated source images. It checks the process and job again after verifying images. `accept` additionally validates the pending request identity, body hash, exact completion fields and model result before observing the native owner. Only success consumes the pending request. Its observation receipt deliberately has no process-retirement claim.

Five tests use actual Windows child processes attached to jobs at creation through `PROC_THREAD_ATTRIBUTE_JOB_LIST`. They cover positive live observation, wrong birth/job refusal, an exited process through its original handle, source changes, and completion/result/request binding against those live handles. Test cleanup terminates only its own job, observes original child exit and closes its original handles. No model is imported or substituted. The completion payload is a synthetic normalized vector fixture; these tests establish the acceptance boundary, not inference correctness or installed reuse. All five tests pass.

The service must call this observer under its own ownership/request lock and retain those exact handles and source baselines throughout observation and delivery. This module does not create an owner, authenticate a release, fence a failed lease, manage cancellation, or prove retirement; the caller still must implement those lifecycle operations. None of these observations enables version 1 to accept a live worker result.

## Required integration

1. Add a reusable bootstrap path only to a newly selected and protected release containing the codec. Validate the same source/catalog/checkpoint dependency images before constructing a model. Cache one selected CPU model per worker; retain the existing finite path for rollback.
2. Retain the original native job, process/thread handles and pipe handles across requests. Never rediscover or adopt a worker from its PID. Revalidate the original process image, creation identity, job membership and selected release when accepting completion. A completion frame alone is insufficient.
3. Drive a single worker with a queue capped at four admissions, at most 32 requests per lease, and finite queued/request deadlines. Do not put an unbounded executor or hidden model queue behind the cap. Refuse stale release/epoch/nonce/sequence/body identities before inference or result delivery.
4. Keep request completion and lease retirement separate in the service protocol and Memory client. Validate result model/revision/vector shape with the existing validator. Accept a reusable result only with the new ownership/completion evidence; do not label a live worker as joined to satisfy the version 1 contract.
5. Expire idle leases, enforce a finite lease lifetime, and apply the existing RAM reserve before loading or retaining a model. Replacing an idle model first retires its original worker and joins its streams. Model-changing calls never accumulate both models in one process.
6. Cancellation, caller disconnect, drain, service replacement and idle expiry retain their original cleanup operation until actual worker exit, pipe readers/writers and native handles are joined. An observation timeout fences reuse and retains uncertainty; it does not authorize a replacement or a successful result.
7. Update the native provisioning/source pins, service receipts and Memory client together. Verify warm repeated requests reuse the same admitted process/model, then verify idle unloading, capacity, queue expiry, input/model failure, cancellation, late output, source/epoch replacement and real retirement. Preserve failed runs. Only then deploy the matching cohort and test Gemma reindex and retrieval.

Actual native ownership, model residency, service/client integration, installed deployment and acceptance remain unfinished. Automatic Raya capture remains a separate outstanding requirement.
