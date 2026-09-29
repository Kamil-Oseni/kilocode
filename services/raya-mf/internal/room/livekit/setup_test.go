// raya_change - Actual join owner cancellation and late cleanup receipts.
package livekit

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/room"
)

type resource struct {
	done     chan struct{}
	closed   chan struct{}
	once     sync.Once
	calls    atomic.Int32
	closeErr error
	err      error
}

func (*resource) Input() <-chan engine.Frame { return nil }
func (*resource) Data() <-chan room.Data     { return nil }
func (*resource) Publish(context.Context, engine.Frame) error {
	return errors.New("unused publication")
}
func (*resource) Send(context.Context, room.Data) error { return errors.New("unused send") }
func (*resource) Flush(context.Context, string) error   { return errors.New("unused flush") }
func (r *resource) Close() error {
	r.calls.Add(1)
	r.once.Do(func() { close(r.closed) })
	return r.closeErr
}
func (r *resource) Done() <-chan struct{} { return r.done }
func (r *resource) Err() error            { return r.err }

func terminal(t *testing.T, cleanup room.Cleanup) {
	t.Helper()
	select {
	case <-cleanup.Done():
	case <-time.After(time.Second):
		t.Fatal("actual join owner did not terminate")
	}
}

func TestSetupPrecancelledNeverStartsNativeOperation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var calls atomic.Int32
	value, err := join(ctx, func(*setup) (room.Room, error) { calls.Add(1); return nil, nil })
	if value != nil || !errors.Is(err, context.Canceled) || calls.Load() != 0 {
		t.Fatal("cancelled join started native work")
	}
	if _, err := join(context.Background(), nil); err == nil {
		t.Fatal("missing operation admitted")
	}
}

func TestSetupOwnsWedgedOperationUntilActualCleanupReturns(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	finishing := make(chan struct{})
	finish := make(chan struct{})
	var once, final sync.Once
	defer once.Do(func() { close(release) })
	defer final.Do(func() { close(finish) })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	var calls atomic.Int32
	go func() {
		_, err := join(ctx, func(owner *setup) (room.Room, error) {
			calls.Add(1)
			close(entered)
			<-release
			if !owner.stopped() {
				t.Error("late operation was not fenced")
			}
			close(finishing)
			<-finish
			return nil, errors.New("join refused")
		})
		result <- err
	}()
	admitted(t, entered)
	cancel()
	err := outcome(t, result)
	var failure *room.SetupError
	if !errors.As(err, &failure) || !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled owner lacks cleanup receipt")
	}
	select {
	case <-failure.Cleanup.Done():
		t.Fatal("wedged native operation declared ended")
	default:
	}
	once.Do(func() { close(release) })
	admitted(t, finishing)
	select {
	case <-failure.Cleanup.Done():
		t.Fatal("incomplete cleanup declared ended")
	default:
	}
	final.Do(func() { close(finish) })
	terminal(t, failure.Cleanup)
	if failure.Cleanup.Err() != nil || calls.Load() != 1 {
		t.Fatal("join was replaced or admission refusal became cleanup uncertainty")
	}
}

func TestSetupAbandonedLateRoomWaitsActualTerminalInsteadOfCloseTimeout(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	value := &resource{done: make(chan struct{}), closed: make(chan struct{}), closeErr: receiverUnknown}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		_, err := join(ctx, func(*setup) (room.Room, error) { close(entered); <-release; return value, nil })
		result <- err
	}()
	admitted(t, entered)
	cancel()
	err := outcome(t, result)
	var failure *room.SetupError
	if !errors.As(err, &failure) {
		t.Fatal("abandoned join did not retain owner")
	}
	once.Do(func() { close(release) })
	admitted(t, value.closed)
	select {
	case <-failure.Cleanup.Done():
		t.Fatal("bounded Room.Close fabricated actual terminal")
	default:
	}
	close(value.done)
	terminal(t, failure.Cleanup)
	if failure.Cleanup.Err() != nil || value.calls.Load() != 1 {
		t.Fatal("actual cleanup was not settled once")
	}
}

func TestSetupCancellationConcurrentWithSuccessNeverReturnsLiveRoom(t *testing.T) {
	value := &resource{done: make(chan struct{}), closed: make(chan struct{})}
	close(value.done)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result, err := join(ctx, func(*setup) (room.Room, error) { cancel(); return value, nil })
	var failure *room.SetupError
	if result != nil || !errors.As(err, &failure) || !errors.Is(err, context.Canceled) {
		t.Fatal("late live room escaped cancellation")
	}
	terminal(t, failure.Cleanup)
	if value.calls.Load() != 1 {
		t.Fatal("late success cleanup was not once")
	}
}

func TestSetupCleanRefusalSeparatesCauseAndActualCleanupFailure(t *testing.T) {
	cause := errors.New("native admission refused")
	cleanup := errors.New("native cleanup failed")
	_, err := join(context.Background(), func(owner *setup) (room.Room, error) { defer owner.settle(cleanup); return nil, cause })
	var failure *room.SetupError
	if !errors.As(err, &failure) || !errors.Is(err, cause) {
		t.Fatal("native refusal lost its cause")
	}
	terminal(t, failure.Cleanup)
	if !errors.Is(failure.Cleanup.Err(), cleanup) {
		t.Fatal("cleanup uncertainty was not retained")
	}
}

func TestSetupSuccessfulCallerOwnsRoomWithoutHelperCleanup(t *testing.T) {
	value := &resource{done: make(chan struct{}), closed: make(chan struct{})}
	result, err := join(context.Background(), func(*setup) (room.Room, error) { return value, nil })
	if err != nil || result != value || value.calls.Load() != 0 {
		t.Fatal("successful join ownership was not transferred")
	}
}
