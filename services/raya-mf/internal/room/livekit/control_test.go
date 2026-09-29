// raya_change - Actual single-owner control publisher adverse boundaries.
package livekit

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/room"
	protocol "github.com/Kilo-Org/kilocode/services/raya-mf/internal/wire"
)

func publisher(t *testing.T, write func(room.Data) error) *control {
	t.Helper()
	c, err := newControl(write)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := c.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	return c
}

func admitted(t *testing.T, entered <-chan struct{}) {
	t.Helper()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("owned writer was not admitted")
	}
}

func outcome(t *testing.T, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-time.After(time.Second):
		t.Fatal("owned send did not return within its deadline")
		return nil
	}
}

func TestControlRefusesInvalidCancelledAndStoppedWithoutEffects(t *testing.T) {
	var calls atomic.Int32
	c := publisher(t, func(room.Data) error { calls.Add(1); return nil })
	for _, data := range []room.Data{{}, {Topic: "topic", Body: make([]byte, 15361)}, {Topic: strings.Repeat("x", 129), Body: []byte{1}}, {Topic: " topic", Body: []byte{1}}, {Topic: "\xff", Body: []byte{1}}, {Topic: "topic", Body: []byte{1}, Identity: strings.Repeat("x", 257)}} {
		if c.Send(context.Background(), data) == nil {
			t.Fatal("invalid data admitted")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if !errors.Is(c.Send(ctx, room.Data{Topic: "topic", Body: []byte{1}}), context.Canceled) || calls.Load() != 0 {
		t.Fatal("cancelled request had effects")
	}
	if err := c.Send(context.Background(), room.Data{Topic: strings.Repeat("x", 128), Body: make([]byte, 15360)}); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatal("bounded valid write was not handed to SDK once")
	}
	if err := c.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(c.Send(context.Background(), room.Data{Topic: "topic", Body: []byte{1}}), controlStopped) || calls.Load() != 1 {
		t.Fatal("stopped publisher wrote")
	}
	if _, err := newControl(nil); err == nil {
		t.Fatal("nil writer admitted")
	}
}

func TestControlAcceptsMaximumProviderCaption(t *testing.T) {
	body, err := json.Marshal(protocol.Transcript{Type: "transcript.output.delta", Item: "event-caption", Text: strings.Repeat("a", 8192)})
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	c := publisher(t, func(data room.Data) error {
		calls.Add(1)
		if data.Topic != "raya.transcript" || !bytes.Equal(data.Body, body) {
			t.Error("provider caption changed during handoff")
		}
		return nil
	})
	if err := c.Send(context.Background(), room.Data{Topic: "raya.transcript", Body: body}); err != nil || calls.Load() != 1 {
		t.Fatal("valid maximum provider caption refused", err)
	}
}

func TestControlBlockedWriterOwnsCopyAndBusyThenSealsWithoutReplay(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	var calls atomic.Int32
	seen := make(chan room.Data, 1)
	c := publisher(t, func(data room.Data) error {
		calls.Add(1)
		close(entered)
		<-release
		seen <- data
		return nil
	})
	body := []byte("owned")
	result := make(chan error, 1)
	go func() {
		result <- c.Send(context.Background(), room.Data{Topic: "original", Body: body, Identity: "client"})
	}()
	admitted(t, entered)
	body[0] = 'X'
	if !errors.Is(c.Send(context.Background(), room.Data{Topic: "other", Body: []byte{1}}), controlBusy) {
		t.Fatal("concurrent send was queued")
	}
	if !errors.Is(outcome(t, result), controlUnknown) {
		t.Fatal("blocked accepted write was confirmed")
	}
	if !errors.Is(c.Close(context.Background()), controlUnknown) {
		t.Fatal("blocked close fabricated drain")
	}
	if !errors.Is(c.Send(context.Background(), room.Data{Topic: "other", Body: []byte{1}}), controlStopped) {
		t.Fatal("timed out write replayed")
	}
	select {
	case <-c.end:
		t.Fatal("blocked owner disappeared")
	default:
	}
	once.Do(func() { close(release) })
	data := <-seen
	if !bytes.Equal(data.Body, []byte("owned")) || data.Topic != "original" || data.Identity != "client" {
		t.Fatal("caller mutated owned data")
	}
	if err := c.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatal("late SDK success caused replay")
	}
}

func TestControlWriterErrorIsUnknownAndNeverRetries(t *testing.T) {
	var calls atomic.Int32
	failure := errors.New("SDK write failed")
	c := publisher(t, func(room.Data) error { calls.Add(1); return failure })
	err := c.Send(context.Background(), room.Data{Topic: "topic", Body: []byte{1}})
	if !errors.Is(err, controlUnknown) || !errors.Is(err, failure) {
		t.Fatal("SDK failure was treated as definite refusal")
	}
	if !errors.Is(c.Send(context.Background(), room.Data{Topic: "topic", Body: []byte{1}}), controlStopped) || calls.Load() != 1 {
		t.Fatal("failed write replayed")
	}
}

func TestControlStopDuringAcceptedWriteRetainsOwnerUntilReturn(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	c := publisher(t, func(room.Data) error { close(entered); <-release; return nil })
	result := make(chan error, 1)
	go func() { result <- c.Send(context.Background(), room.Data{Topic: "topic", Body: []byte{1}}) }()
	admitted(t, entered)
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	if !errors.Is(c.Close(ctx), controlUnknown) {
		t.Fatal("Stop invented completion")
	}
	if !errors.Is(outcome(t, result), controlUnknown) {
		t.Fatal("Stop changed unknown accepted outcome")
	}
	once.Do(func() { close(release) })
	if err := c.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestControlCallerCancellationAfterAdmissionIsUnknown(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	c := publisher(t, func(room.Data) error { close(entered); <-release; return nil })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- c.Send(ctx, room.Data{Topic: "topic", Body: []byte{1}}) }()
	admitted(t, entered)
	cancel()
	err := outcome(t, result)
	if !errors.Is(err, controlUnknown) || !errors.Is(err, context.Canceled) {
		t.Fatal("accepted cancellation lost uncertainty")
	}
	once.Do(func() { close(release) })
	if err := c.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}
