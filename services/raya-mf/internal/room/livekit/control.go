// raya_change - One owned bounded SDK data handoff, never a remote acceptance receipt.
package livekit

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"unicode/utf8"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/room"
)

var controlUnknown = errors.New("data publication completion is unknown; publisher stopped")
var controlStopped = errors.New("data publisher is stopped")
var controlBusy = errors.New("data publisher already owns a write")

type command struct {
	ctx  context.Context
	data room.Data
	ack  chan error
}

type control struct {
	work    chan command
	done    chan struct{}
	end     chan struct{}
	once    sync.Once
	stopped atomic.Bool
	active  atomic.Bool
}

func newControl(write func(room.Data) error) (*control, error) {
	if write == nil {
		return nil, errors.New("data writer is required")
	}
	c := &control{work: make(chan command), done: make(chan struct{}), end: make(chan struct{})}
	go c.run(write)
	return c, nil
}

// Send admits at most one owned copy. Nil means only the SDK call returned nil:
// SDK internals may hide data-channel errors, and remote acceptance/playback is unproved.
func (c *control) Send(ctx context.Context, data room.Data) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if c.stopped.Load() {
		return controlStopped
	}
	if len(data.Body) == 0 || len(data.Body) > 4096 || len(data.Topic) == 0 || len(data.Topic) > 128 || !utf8.ValidString(data.Topic) || strings.TrimSpace(data.Topic) != data.Topic || len(data.Identity) > 256 || !utf8.ValidString(data.Identity) {
		return errors.New("invalid bounded data publication")
	}
	if !c.active.CompareAndSwap(false, true) {
		return controlBusy
	}
	defer c.active.Store(false)
	ctx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	data.Body = append([]byte(nil), data.Body...)
	job := command{ctx: ctx, data: data, ack: make(chan error, 1)}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-c.done:
		return controlStopped
	case c.work <- job:
	}
	select {
	case err := <-job.ack:
		if err != nil {
			return err
		}
		if c.stopped.Load() || ctx.Err() != nil {
			c.stop()
			return errors.Join(controlUnknown, ctx.Err())
		}
		return nil
	case <-ctx.Done():
		c.stop()
		return errors.Join(controlUnknown, ctx.Err())
	case <-c.done:
		select {
		case err := <-job.ack:
			if err != nil {
				return err
			}
		default:
		}
		return controlUnknown
	}
}

// Close fences immediately. A blocked SDK write remains the single owned worker
// until it actually returns; a deadline does not fabricate a confirmed drain.
func (c *control) Close(ctx context.Context) error {
	c.stop()
	ctx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	select {
	case <-c.end:
		return nil
	case <-ctx.Done():
		select {
		case <-c.end:
			return nil
		default:
			return errors.Join(controlUnknown, ctx.Err())
		}
	}
}

func (c *control) stop() {
	c.once.Do(func() { c.stopped.Store(true); close(c.done) })
}

func (c *control) run(write func(room.Data) error) {
	defer close(c.end)
	for {
		select {
		case <-c.done:
			return
		case job := <-c.work:
			if c.stopped.Load() {
				job.ack <- controlUnknown
				continue
			}
			if err := job.ctx.Err(); err != nil {
				c.stopped.Store(true)
				job.ack <- errors.Join(controlUnknown, err)
				c.stop()
				continue
			}
			if err := write(job.data); err != nil {
				c.stopped.Store(true)
				job.ack <- errors.Join(controlUnknown, err)
				c.stop()
				continue
			}
			job.ack <- nil
		}
	}
}
