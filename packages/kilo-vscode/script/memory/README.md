# Disposable Memory supervisor

Root must review the dependency closure and native
provisioning receipt before admitting any service import or model-free test.
No installed service, original credentials, personal root or existing ledger is
adopted. The selected external sources are unchanged.

The wrapper executes the original retained `server.py` as `__main__`, including
its original `finally` hooks. It substitutes only `uvicorn.run` with a retained
`uvicorn.Server`. A non-daemon original input reader accepts literal `STOP` or
stdin EOF and sets `server.should_exit`. Signals are not intercepted; there is
no terminate, kill, force-exit, graceful-shutdown deadline or restart. Shutdown
can remain pending indefinitely behind a caller's observation deadline.

Both original pools are joined again independently if the existing sequential
cleanup raises. Every retained reservation/inference/publication/terminal-write
future is observed. Original primary and cleanup errors are aggregated. Active,
uncertain or unfinished request state refuses success. The bounded output
receipt exposes error types, not notes, credentials or exception messages.
The Python exception group remains the original diagnostic; a parent must keep
stderr private and must not publish arbitrary exception bodies.

`supervise_test.py` retains the original CPython child process object and both
original pipe-reader threads. Readers start before process creation; oversized
output is discarded while draining to actual EOF and remains a failure. Test
failure requests only ordinary STOP/EOF, then waits for the same child and both
readers. No observation deadline certifies retirement. CPython process handles
are original held handles; this is not creation-time job containment of the
service family. The selected Retrieval owner independently owns inference jobs.

## Root-reviewed service plan contract

Invoke fixed Python3.12.14 with `-I -S -B -u supervise.py PLAN PLAN_SHA` from an
already protected private bootstrap, explicit system whitelist and private
HOME/TEMP. The plan must have format `raya.memory.disposable.supervisor`, version1,
kind `memory` or `retrieval`, and `execution_admitted:true`. Every execution
requires a separately reviewed, fresh admitted plan.

The plan selects an exclusively fresh canonical `raya-memory-disposable-*` root,
its separately reviewed native ACL/protection receipt, and all admitted directory
dev/inode/ctime generations. All files carry exact bytes/SHA and original
dev/inode/size/mtime/ctime/nlink tuples. The source map is fixed to Memory v3.1
(nine sources) or Retrieval WorkerIntegration-v5 (seven sources); no arbitrary
release is permitted. The Python image SHA is fixed, and the complete selected
site-packages/runtime/catalog input closure must be independently reviewed.
The wrapper validates it before adding the selected dependency path or importing
service code. Directory and dependency checks do not attest loaded image memory
or eliminate same-account replacement between validation and load.

Every note/token/operation/receipt path must be under the disposable root.
Tokens must be freshly generated for the fixture by an admitted provisioning
step; the preparation lane never reads token bodies. The environment is explicit
and rejects unknown keys, Python path/home injection, shared HOME/caches and
online HF loading. No `.pth` processing or ambient site-packages is enabled.

For model-free testing, supply a master plan through
`RAYA_MEMORY_SUPERVISOR_TEST_PLAN` and `RAYA_MEMORY_SUPERVISOR_TEST_SHA`. It binds
the supervisor/Python SHA, explicit bootstrap environment/cwd and separate fresh
service plans for STOP and EOF. A health GET authenticates only to the disposable
service, validates selected source map/ready/active0, then requests ordinary stop.
The master also binds a fresh protected diagnostics root, its native birth
generation and its protection receipt. Each case saves bounded original stream
sidecars and a terminal record there, including failures. Keep these files
private; raw exception output is not certified free of sensitive content.
The test does not issue embeddings, rerank, sync or search. Memory initialization
does load its local tokenizer; native namespace observation occurs at import.
These effects require Root admission despite the absence of inference.

## Gates still pending

On 2026-10-04, two fresh Retrieval health cases passed with ordinary STOP and EOF
shutdown, original process and both streams joined, and no force. Health took
22.61 and 22.078 seconds within the unchanged 30-second observation. Saved outcome
review is `.tmp/new-pc/memory-retrieval-diagnostic-outcome-independent-actual-next.json`
in the worktree. The earlier Stop timeout remains failed with its cause unproved.
Memory service import and genuine held-operation/storage/worker failure regressions remain
required before claiming complete retirement. Ordinary health+close acceptance
would not replace installed native source review, confirmed sync, search or
actual downstream certificates. `Disable source policy` still reports
`hostJoinRequired:true`; this wrapper does not make installed Fully Paused true.
