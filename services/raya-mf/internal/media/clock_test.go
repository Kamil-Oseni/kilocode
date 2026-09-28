// raya_change - Deterministic frame replay for Raya's media clock.
package media

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
)

func TestClockEmitsExactSilentFrames(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	clock := NewClock(24000)
	ticks := make(chan time.Time)
	base := time.Unix(0, 0)
	var prior time.Time
	jitter := make([]time.Duration, 0, 2999)
	go clock.RunWithTicks(ctx, ticks)

	for index := range 3000 {
		ticks <- base.Add(time.Duration(index) * 20 * time.Millisecond)
		frame := <-clock.Output()
		if !prior.IsZero() {
			gap := frame.At.Sub(prior)
			jitter = append(jitter, abs(gap-20*time.Millisecond))
		}
		prior = frame.At
		if frame.Rate != 24000 {
			t.Fatalf("frame rate = %d, want 24000", frame.Rate)
		}
		if len(frame.PCM) != 960 {
			t.Fatalf("frame bytes = %d, want 960", len(frame.PCM))
		}
		for _, sample := range frame.PCM {
			if sample != 0 {
				t.Fatal("underrun frame was not silence")
			}
		}
	}
	close(ticks)
	if jitter[len(jitter)*99/100] != 0 {
		t.Fatalf("deterministic p99 jitter = %s, want 0", jitter[len(jitter)*99/100])
	}
}

func abs(value time.Duration) time.Duration {
	if value < 0 {
		return -value
	}
	return value
}

func running(t *testing.T) (*Clock, chan time.Time) {
	t.Helper()
	clock := NewClock(24000)
	ticks := make(chan time.Time)
	ctx, cancel := context.WithCancel(context.Background())
	go clock.RunWithTicks(ctx, ticks)
	t.Cleanup(func() {
		cancel()
		select {
		case <-clock.done:
		case <-time.After(time.Second):
			t.Error("clock did not close")
		}
	})
	return clock, ticks
}

func tick(t *testing.T, ticks chan time.Time, at time.Time) {
	t.Helper()
	select {
	case ticks <- at:
	case <-time.After(time.Second):
		t.Fatal("clock tick blocked")
	}
}

func frame(t *testing.T, clock *Clock) engine.Frame {
	t.Helper()
	select {
	case value, ok := <-clock.Output():
		if !ok {
			t.Fatal("clock output closed unexpectedly")
		}
		return value
	case <-time.After(time.Second):
		t.Fatal("frame did not arrive")
	}
	return engine.Frame{}
}

func wait(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("clock condition timed out")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestClockPreservesInterleavedItemRangesAndOwnsPCM(t *testing.T) {
	clock, ticks := running(t)
	pcm := bytes.Repeat([]byte{1, 2}, 240)
	if !clock.Submit(Chunk{Item: "a", PCM: pcm}) || !clock.Submit(Chunk{Item: "b", PCM: bytes.Repeat([]byte{3, 4}, 480)}) || !clock.Submit(Chunk{Item: "a", PCM: bytes.Repeat([]byte{5, 6}, 240)}) {
		t.Fatal("valid chunks were rejected")
	}
	clear(pcm)
	tick(t, ticks, time.Unix(0, 0))
	first := frame(t, clock)
	if first.Item != "a" || first.Start != 0 || first.End != 240 || first.Seq != 1 || first.Epoch != 1 || !bytes.Equal(first.PCM[:480], bytes.Repeat([]byte{1, 2}, 240)) || !bytes.Equal(first.PCM[480:], make([]byte, 480)) {
		t.Fatalf("first attributed partial frame = %+v", first)
	}
	tick(t, ticks, time.Unix(0, 20_000_000))
	second := frame(t, clock)
	if second.Item != "b" || second.Start != 0 || second.End != 480 || !bytes.Equal(second.PCM, bytes.Repeat([]byte{3, 4}, 480)) {
		t.Fatal("a frame mixed different items")
	}
	tick(t, ticks, time.Unix(0, 40_000_000))
	third := frame(t, clock)
	if third.Item != "a" || third.Start != 240 || third.End != 480 {
		t.Fatal("interleaved item offset reset")
	}
	tick(t, ticks, time.Unix(0, 60_000_000))
	silent := frame(t, clock)
	if silent.Item != "" || silent.Start != 0 || silent.End != 0 || silent.Seq != 4 {
		t.Fatal("silence was attributed to prior item")
	}
}

func TestClockBoundsBurstsAndPreservesRejectedSampleGaps(t *testing.T) {
	clock, ticks := running(t)
	if clock.Submit(Chunk{Item: "a", PCM: make([]byte, clock.size*6)}) {
		t.Fatal("oversized burst was accepted")
	}
	if !clock.Submit(Chunk{Item: "a", PCM: bytes.Repeat([]byte{1, 2}, 480)}) {
		t.Fatal("bounded chunk rejected")
	}
	tick(t, ticks, time.Time{})
	value := frame(t, clock)
	if value.Start != 2880 || value.End != 3360 || clock.Loss().DroppedBytes != 5760 {
		t.Fatal("overflow was hidden by closing the original sample gap")
	}
	for range 50 {
		clock.Submit(Chunk{Item: "b", PCM: make([]byte, clock.size)})
	}
	for index := range 8 {
		tick(t, ticks, time.Unix(0, int64(index)*20_000_000))
		frame(t, clock)
	}
	if clock.Loss().QueuedBytes > uint64(clock.size*queued) || clock.Loss().DroppedBytes <= 5760 {
		t.Fatal("burst queue exceeded its bound or silently overflowed")
	}
}

func TestClockReservesInterleavedPartialFrameSlotsAtIngress(t *testing.T) {
	clock, ticks := running(t)
	for index := range queued {
		if !clock.Submit(Chunk{Item: fmt.Sprintf("partial_%d", index), PCM: []byte{1, 2}}) {
			t.Fatal("bounded partial frame rejected")
		}
	}
	if clock.Submit(Chunk{Item: "overflow", PCM: []byte{3, 4}}) {
		t.Fatal("tiny interleaved chunks bypassed the scheduled tick bound")
	}
	for index := range queued {
		tick(t, ticks, time.Unix(0, int64(index)*20_000_000))
		value := frame(t, clock)
		if value.Item != fmt.Sprintf("partial_%d", index) || value.Start != 0 || value.End != 1 {
			t.Fatal("partial item scheduling lost attribution")
		}
	}
	if !clock.Submit(Chunk{Item: "overflow", PCM: []byte{3, 4}}) {
		t.Fatal("consumed partial frames did not release admission slots")
	}
	tick(t, ticks, time.Unix(0, 100_000_000))
	value := frame(t, clock)
	if value.Start != 1 || value.End != 2 || clock.Loss().DroppedBytes != 2 {
		t.Fatal("rejected partial sample gap was hidden")
	}
}

func TestClockReleasesConsumedBurstSlotsBeforeWholeChunkEnds(t *testing.T) {
	clock, ticks := running(t)
	if !clock.Submit(Chunk{Item: "burst", PCM: bytes.Repeat([]byte{1, 2}, 480*queued)}) {
		t.Fatal("100 ms bounded burst rejected")
	}
	tick(t, ticks, time.Time{})
	first := frame(t, clock)
	if first.Item != "burst" || first.Start != 0 || first.End != 480 {
		t.Fatal("first burst frame lost its range")
	}
	if !clock.Submit(Chunk{Item: "delta", PCM: bytes.Repeat([]byte{3, 4}, 480)}) {
		t.Fatal("consuming 20 ms did not release one admission slot")
	}
	if clock.Submit(Chunk{Item: "overflow", PCM: []byte{5, 6}}) {
		t.Fatal("partly consumed burst exceeded five pending ticks")
	}
	for index := 1; index < queued; index++ {
		tick(t, ticks, time.Unix(0, int64(index)*20_000_000))
		value := frame(t, clock)
		if value.Item != "burst" || value.Start != uint64(index*480) || value.End != uint64((index+1)*480) {
			t.Fatal("continued burst range changed after admission")
		}
	}
	tick(t, ticks, time.Unix(0, 100_000_000))
	value := frame(t, clock)
	if value.Item != "delta" || value.Start != 0 || value.End != 480 || !bytes.Equal(value.PCM, bytes.Repeat([]byte{3, 4}, 480)) || clock.Loss().QueuedBytes != 0 {
		t.Fatal("admitted delta was later dropped or misattributed")
	}
}

func TestClockSlowConsumerNeverBlocksAndKeepsNewestTick(t *testing.T) {
	clock, ticks := running(t)
	for index := range 12 {
		tick(t, ticks, time.Unix(0, int64(index)*20_000_000))
		wait(t, func() bool {
			count, _ := clock.Stats()
			return count == uint64(index+1) && clock.Loss().DroppedFrames == uint64(index)
		})
	}
	value := frame(t, clock)
	if value.Seq != 12 || value.Item != "" || clock.Loss().DroppedFrames != 11 {
		t.Fatal("slow consumer received stale tick or blocked scheduling")
	}
}

func TestClockDropFencesBufferedAndLatePCMBeforeAppliedACK(t *testing.T) {
	clock, ticks := running(t)
	if !clock.Submit(Chunk{Item: "a", PCM: make([]byte, clock.size*3)}) {
		t.Fatal("valid burst rejected")
	}
	tick(t, ticks, time.Time{})
	wait(t, func() bool { count, _ := clock.Stats(); return count == 1 })
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := clock.Drop(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-clock.Output():
		t.Fatal("pre-cancellation buffered output survived applied ACK")
	default:
	}
	if clock.Loss().QueuedBytes != 0 || clock.Submit(Chunk{Item: "a", PCM: make([]byte, clock.size)}) || clock.Submit(Chunk{Item: "b", Epoch: 1, PCM: make([]byte, clock.size)}) {
		t.Fatal("cancelled item or stale epoch was admitted")
	}
	if !clock.Submit(Chunk{Item: "b", PCM: make([]byte, clock.size)}) {
		t.Fatal("new item after cancellation rejected")
	}
	tick(t, ticks, time.Unix(0, 20_000_000))
	value := frame(t, clock)
	if value.Item != "b" || value.Epoch != 2 || value.Seq != 2 || value.Start != 0 || value.End != 480 {
		t.Fatal("replacement frame lost cancellation provenance")
	}
}

func TestClockInvalidInputAndClosedLegacyInputDoNotSpin(t *testing.T) {
	clock, ticks := running(t)
	for _, chunk := range []Chunk{{Item: "a", PCM: []byte{1}}, {Item: "", PCM: []byte{1, 2}}, {Item: "界", PCM: []byte{1, 2}}, {Item: "a"}} {
		if clock.Submit(chunk) {
			t.Fatal("invalid PCM/item was accepted")
		}
	}
	clock.Input() <- Chunk{Item: "legacy", PCM: []byte{7, 8}}
	close(clock.input)
	tick(t, ticks, time.Time{})
	value := frame(t, clock)
	if value.Item != "legacy" || value.End != 1 || value.PCM[0] != 7 {
		t.Fatal("legacy input closure lost already accepted samples")
	}
	for index := range 4 {
		tick(t, ticks, time.Unix(0, int64(index+1)*20_000_000))
		if frame(t, clock).Item != "" {
			t.Fatal("closed input repeated stale attribution")
		}
	}
	if clock.Loss().InvalidChunks != 4 {
		t.Fatal("invalid input was not counted distinctly")
	}
}

func TestClockInvalidRateAndCancellationCloseExactlyOnce(t *testing.T) {
	for _, rate := range []int{-1, 0, 7999, 24001, 96001, int(^uint(0) >> 1)} {
		clock := NewClock(rate)
		go clock.RunWithTicks(context.Background(), make(chan time.Time))
		select {
		case _, ok := <-clock.Output():
			if ok {
				t.Fatal("invalid rate emitted PCM")
			}
		case <-time.After(time.Second):
			t.Fatal("invalid rate did not close")
		}
		if clock.Submit(Chunk{Item: "a", PCM: []byte{1, 2}}) {
			t.Fatal("closed clock accepted PCM")
		}
		if err := clock.Drop(context.Background(), "a"); !errors.Is(err, ErrClosed) {
			t.Fatal("closed clock accepted cancellation")
		}
		clock.RunWithTicks(context.Background(), nil)
	}
}

func TestClockCancellationRefusalAndExhaustionNeverForgetFences(t *testing.T) {
	clock, ticks := running(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := clock.Drop(ctx, "a"); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled request changed clock")
	}
	if !clock.Submit(Chunk{Item: "a", PCM: make([]byte, clock.size)}) {
		t.Fatal("cancelled Drop fenced valid item")
	}
	tick(t, ticks, time.Time{})
	if frame(t, clock).Epoch != 1 {
		t.Fatal("cancelled request advanced epoch")
	}
	for index := range identities {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		err := clock.Drop(ctx, fmt.Sprintf("item_%d", index))
		cancel()
		if err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel = context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := clock.Drop(ctx, "overflow"); !errors.Is(err, ErrCapacity) {
		t.Fatal("cancellation exhaustion forgot an earlier fence")
	}
	select {
	case <-clock.done:
	case <-time.After(time.Second):
		t.Fatal("exhausted clock did not fail closed")
	}
	if clock.Submit(Chunk{Item: "new", PCM: make([]byte, clock.size)}) {
		t.Fatal("exhausted clock restarted")
	}
}
