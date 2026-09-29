package process

import (
	"sync"
	"sync/atomic"
	"time"
)

const (
	traceReceive = iota
	traceWriteBegin
	traceWriteEnd
	traceAckParsed
	traceAckCorrelated
	traceAckForwarded
	traceAckConsumed
	traceFinish
)

// One fixed parent-local value. Enums: operation1=publish,2=send,3=flush;
// outcome1=confirmed,2=refused,3=unknown,4=unadmitted deadline,5=stopped.
// Stages is the presence bitmask: missing timestamps are unknown, not zero delay.
// Incomplete means diagnostic contention lost updates, not a native phase.
// Write completion proves stdio handoff, never native encoding or playback.
type observation struct {
	Available  bool   `json:"available"`
	Incomplete bool   `json:"incomplete"`
	Dropped    uint64 `json:"droppedUpdates"`
	ID         uint64 `json:"id"`
	Operation  uint8  `json:"operation"`
	Budget     int64  `json:"budgetNs"`
	Expires    int64  `json:"wireExpiresMs"`
	Stages     uint16 `json:"stages"`
	Received   int64  `json:"writerReceivedNs"`
	Begin      int64  `json:"writeBeginNs"`
	End        int64  `json:"writeEndNs"`
	WriteOK    bool   `json:"writeSucceeded"`
	Parsed     int64  `json:"ackParsedNs"`
	Ack        uint8  `json:"ackOutcome"`
	Correlated bool   `json:"ackCorrelated"`
	Forwarded  bool   `json:"ackForwarded"`
	Consumed   int64  `json:"ackConsumedNs"`
	Finished   int64  `json:"callerFinishedNs"`
	Outcome    uint8  `json:"callerOutcome"`
	start      time.Time
	base       uint64
}

type trace struct {
	mu      sync.Mutex
	wanted  atomic.Uint64
	dropped atomic.Uint64
	value   observation
}

func (t *trace) begin(id uint64, op string, start, expires time.Time) {
	t.wanted.Store(id)
	base := t.dropped.Load()
	if !t.mu.TryLock() {
		t.dropped.Add(1)
		return
	}
	defer t.mu.Unlock()
	operation := uint8(0)
	switch op {
	case "publish":
		operation = 1
	case "send":
		operation = 2
	case "flush":
		operation = 3
	}
	t.value = observation{Available: true, ID: id, Operation: operation, Budget: expires.Sub(start).Nanoseconds(), Expires: expires.UnixMilli(), start: start, base: base}
}

func (t *trace) mark(id uint64, stage int, code uint8) {
	at := time.Now()
	if !t.mu.TryLock() {
		t.dropped.Add(1)
		return
	}
	defer t.mu.Unlock()
	if t.value.ID != id || t.wanted.Load() != id {
		return
	}
	bit := uint16(1) << stage
	if t.value.Stages&bit != 0 {
		return
	}
	t.value.Stages |= bit
	ns := at.Sub(t.value.start).Nanoseconds()
	switch stage {
	case traceReceive:
		t.value.Received = ns
	case traceWriteBegin:
		t.value.Begin = ns
	case traceWriteEnd:
		t.value.End = ns
		t.value.WriteOK = code == 1
	case traceAckParsed:
		t.value.Parsed = ns
		t.value.Ack = code
	case traceAckCorrelated:
		t.value.Correlated = true
	case traceAckForwarded:
		t.value.Forwarded = true
	case traceAckConsumed:
		t.value.Consumed = ns
	case traceFinish:
		t.value.Finished = ns
		t.value.Outcome = code
	}
}

func (t *trace) snapshot() observation {
	if !t.mu.TryLock() {
		return observation{ID: t.wanted.Load(), Incomplete: true, Dropped: t.dropped.Load()}
	}
	defer t.mu.Unlock()
	if t.value.ID != t.wanted.Load() {
		return observation{ID: t.wanted.Load(), Incomplete: true, Dropped: t.dropped.Load()}
	}
	value := t.value
	value.Dropped = t.dropped.Load() - value.base
	value.Incomplete = value.Dropped != 0
	value.start = time.Time{}
	value.base = 0
	return value
}

func ackCode(outcome string) uint8 {
	switch outcome {
	case "confirmed":
		return 1
	case "refused":
		return 2
	case "unknown":
		return 3
	}
	return 0
}
