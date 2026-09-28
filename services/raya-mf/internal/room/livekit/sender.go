// raya_change - Single-owner direct RTP writes, without a PCM queue or timer.
package livekit

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtp"
)

var errUnknown = errors.New("RTP send completion is unknown; sender stopped")
var errStopped = errors.New("RTP sender is stopped")
var errBusy = errors.New("RTP sender already owns a write")

const deadline = 20 * time.Millisecond
const payload = 1275

type packet struct {
	ctx  context.Context
	data []byte // Encoded Opus; the sender owns this copy.
	ack  chan error
}

type sender struct {
	work    chan packet
	done    chan struct{}
	end     chan struct{}
	once    sync.Once
	stopped atomic.Bool
	active  atomic.Bool
}

func newSender(write func(*rtp.Packet) error) (*sender, error) {
	if write == nil {
		return nil, errors.New("RTP writer is required")
	}
	seed := make([]byte, 6)
	if _, err := rand.Read(seed); err != nil {
		return nil, err
	}
	s := &sender{work: make(chan packet), done: make(chan struct{}), end: make(chan struct{})}
	go s.run(write, binary.BigEndian.Uint16(seed[:2]), binary.BigEndian.Uint32(seed[2:]))
	return s, nil
}

// Send owns one bounded 20 ms Opus packet until the synchronous writer returns.
// A write timeout/error can have an external side effect, so it seals this
// sender instead of replaying. The adapter must tear down the room transport.
func (s *sender) Send(ctx context.Context, data []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.stopped.Load() {
		return errStopped
	}
	if len(data) == 0 || len(data) > payload {
		return errors.New("invalid encoded 20 ms Opus packet length")
	}
	if !s.active.CompareAndSwap(false, true) {
		return errBusy
	}
	defer s.active.Store(false)
	ctx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	job := packet{ctx: ctx, data: append([]byte(nil), data...), ack: make(chan error, 1)}
	select {
	case <-ctx.Done():
		return ctx.Err() // No worker accepted this packet.
	case <-s.done:
		return errStopped
	case s.work <- job:
	}
	select {
	case err := <-job.ack:
		if err != nil {
			return err
		}
		if s.stopped.Load() {
			return errUnknown
		}
		return nil
	case <-ctx.Done():
		s.stop()
		return errors.Join(errUnknown, ctx.Err())
	case <-s.done:
		return errUnknown
	}
}

// Idle observes only the local writer. The adapter must serialize this check
// with Send; nil is neither remote playback nor a transport drain receipt.
func (s *sender) Idle() error {
	if s.stopped.Load() {
		return errStopped
	}
	if s.active.Load() {
		return errBusy
	}
	return nil
}

// Close refuses all future packets immediately. A blocked external writer is
// retained, at most once per sender, until transport teardown releases it.
// A deadline error explicitly means local termination has not been proved.
func (s *sender) Close(ctx context.Context) error {
	s.stop()
	ctx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	select {
	case <-s.end:
		return nil
	case <-ctx.Done():
		select {
		case <-s.end:
			return nil
		default:
			return errors.Join(errUnknown, ctx.Err())
		}
	}
}

func (s *sender) stop() {
	s.once.Do(func() {
		s.stopped.Store(true)
		close(s.done)
	})
}

func (s *sender) run(write func(*rtp.Packet) error, seq uint16, stamp uint32) {
	defer close(s.end)
	for {
		select {
		case <-s.done:
			return
		case job := <-s.work:
			if s.stopped.Load() {
				job.ack <- errStopped
				continue
			}
			if err := job.ctx.Err(); err != nil {
				s.stop()
				job.ack <- errors.Join(errUnknown, err)
				continue
			}
			frame := &rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 111, SequenceNumber: seq, Timestamp: stamp}, Payload: job.data}
			seq++
			stamp += 960 // RTP Opus uses 48 kHz: one 20 ms clock frame.
			if err := write(frame); err != nil {
				s.stop()
				job.ack <- errors.Join(errUnknown, err)
				continue
			}
			job.ack <- nil
		}
	}
}
