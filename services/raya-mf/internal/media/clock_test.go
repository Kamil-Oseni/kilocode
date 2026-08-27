// raya_change - Deterministic frame replay for Raya's media clock.
package media

import (
	"context"
	"testing"
	"time"
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
