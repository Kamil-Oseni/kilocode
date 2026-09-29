// raya_change - One owned native join with an explicit retained cleanup receipt.
package livekit

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/room"
)

type setup struct {
	abandoned atomic.Bool
	ready     chan struct{}
	decision  chan bool
	done      chan struct{}
	value     room.Room
	cause     error
	mu        sync.Mutex
	err       error
}

func (s *setup) stopped() bool         { return s.abandoned.Load() }
func (s *setup) Done() <-chan struct{} { return s.done }
func (s *setup) Err() error            { s.mu.Lock(); defer s.mu.Unlock(); return s.err }
func (s *setup) settle(err error) {
	if err == nil {
		return
	}
	s.mu.Lock()
	s.err = errors.Join(s.err, err)
	s.mu.Unlock()
}

// The operation owns partial native resources and performs its synchronous
// failure cleanup before returning, recording cleanup-only errors via settle.
// Cancellation returns promptly but retains this one worker until it really ends.
func join(ctx context.Context, operation func(*setup) (room.Room, error)) (room.Room, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if operation == nil {
		return nil, errors.New("native join operation is required")
	}
	s := &setup{ready: make(chan struct{}), decision: make(chan bool, 1), done: make(chan struct{})}
	go func() {
		defer close(s.done)
		if !s.stopped() {
			s.value, s.cause = operation(s)
		}
		if s.value == nil && s.cause == nil {
			s.cause = errors.New("native join returned no room")
		}
		close(s.ready)
		if <-s.decision {
			return
		} // Ownership transferred to the successful caller.
		if s.value == nil {
			return
		}
		err := s.value.Close()
		if cleanup, ok := s.value.(room.Cleanup); ok {
			<-cleanup.Done()
			s.settle(cleanup.Err()) // A prior bounded Close timeout is not a final receipt.
			return
		}
		s.settle(err)
	}()
	select {
	case <-ctx.Done():
		s.abandoned.Store(true)
		s.decision <- false
		return nil, &room.SetupError{Cause: ctx.Err(), Cleanup: s}
	case <-s.ready:
		if err := ctx.Err(); err != nil {
			s.abandoned.Store(true)
			s.decision <- false
			return nil, &room.SetupError{Cause: err, Cleanup: s}
		}
		if s.cause != nil {
			s.abandoned.Store(true)
			s.decision <- false
			return nil, &room.SetupError{Cause: s.cause, Cleanup: s}
		}
		s.decision <- true
		return s.value, nil
	}
}
