// raya_change - Owned bounded RTP receive/reorder/decode lifetime.
package livekit

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtp"
)

var receiverUnknown = errors.New("microphone receiver termination is unconfirmed")
var receiverOverflow = errors.New("microphone receiver bounded packet allowance exhausted")

type incoming struct {
	seq  uint16
	data []byte
}
type receiver struct {
	stopped   atomic.Bool
	once      sync.Once
	mu        sync.Mutex
	err       error
	done      chan struct{}
	end       chan struct{}
	readend   chan struct{}
	decodeend chan struct{}
	packets   chan incoming
	interrupt func() error
	finish    func() error
	report    chan<- error
	reported  sync.Once
}

func newReceiver(read func() (*rtp.Packet, error), interrupt func() error, decode func([]byte) error, finish func() error, reports ...chan<- error) (*receiver, error) {
	if read == nil || interrupt == nil || decode == nil || finish == nil || len(reports) > 1 {
		return nil, errors.New("receiver callbacks are required")
	}
	r := &receiver{done: make(chan struct{}), end: make(chan struct{}), readend: make(chan struct{}), decodeend: make(chan struct{}), packets: make(chan incoming, 8), interrupt: interrupt, finish: finish}
	if len(reports) == 1 {
		r.report = reports[0]
	}
	go r.read(read)
	go r.decode(decode)
	return r, nil
}

func (r *receiver) record(err error) {
	if err == nil {
		return
	}
	r.mu.Lock()
	r.err = errors.Join(r.err, err)
	r.mu.Unlock()
}
func (r *receiver) notify(err error) {
	if err == nil {
		return
	}
	r.reported.Do(func() {
		select {
		case r.report <- err:
		default:
		}
	})
}
func (r *receiver) fail(err error)   { r.record(err); r.stop(); r.notify(err) }
func (r *receiver) settle(err error) { r.record(err); r.notify(err) }

// Stop fences admission synchronously, but never blocks on a native callback.
// One retained cleanup owner joins both loops before closing the decoder.
func (r *receiver) stop() {
	r.once.Do(func() {
		r.stopped.Store(true)
		close(r.done)
		go func() {
			r.settle(r.interrupt())
			<-r.readend
			<-r.decodeend
			r.settle(r.finish())
			close(r.end)
		}()
	})
}

func (r *receiver) Close(ctx context.Context) error {
	r.stop()
	ctx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	select {
	case <-r.end:
		r.mu.Lock()
		defer r.mu.Unlock()
		return r.err
	case <-ctx.Done():
		select {
		case <-r.end:
			r.mu.Lock()
			defer r.mu.Unlock()
			return r.err
		default:
			return errors.Join(receiverUnknown, ctx.Err())
		}
	}
}

func (r *receiver) read(read func() (*rtp.Packet, error)) {
	defer close(r.readend)
	for !r.stopped.Load() {
		packet, err := read()
		if err != nil {
			// EOF ends this publication. It does not prove that the room
			// disconnected; SDK unsubscribe and read termination can race.
			if errors.Is(err, io.EOF) {
				r.stop()
				return
			}
			if !(r.stopped.Load() && (errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) || os.IsTimeout(err) || errors.Is(err, io.ErrClosedPipe))) {
				r.fail(err)
			}
			r.stop()
			return
		}
		if r.stopped.Load() {
			return
		}
		if packet == nil || len(packet.Payload) == 0 || len(packet.Payload) > payload {
			r.fail(errors.New("invalid bounded microphone RTP payload"))
			return
		}
		job := incoming{seq: packet.SequenceNumber, data: append([]byte(nil), packet.Payload...)}
		select {
		case <-r.done:
			return
		case r.packets <- job:
		default:
			r.fail(receiverOverflow)
			return
		}
	}
}

func (r *receiver) decode(write func([]byte) error) {
	defer close(r.decodeend)
	pending := make(map[uint16][]byte)
	var next uint16
	started := false
	var gap time.Time
	var tick <-chan time.Time
	timer := time.NewTimer(time.Hour)
	timer.Stop()
	defer timer.Stop()
	reset := func() {
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		tick = nil
		gap = time.Time{}
		if len(pending) > 0 {
			gap = time.Now().Add(60 * time.Millisecond)
			timer.Reset(time.Until(gap))
			tick = timer.C
		}
	}
	flush := func() bool {
		for {
			data, ok := pending[next]
			if !ok {
				return true
			}
			delete(pending, next)
			if r.stopped.Load() {
				return false
			}
			if err := write(data); err != nil {
				if r.stopped.Load() {
					return false
				}
				r.fail(err)
				return false
			}
			next++
		}
	}
	skip := func() bool {
		var chosen uint16
		found := false
		for seq := range pending {
			if !found || uint16(seq-next) < uint16(chosen-next) {
				chosen = seq
				found = true
			}
		}
		if found {
			next = chosen
			if !flush() {
				return false
			}
		}
		reset()
		return true
	}
	for {
		select {
		case <-r.done:
			return
		case <-tick:
			if !skip() {
				return
			}
		case job := <-r.packets:
			if r.stopped.Load() {
				return
			}
			if !gap.IsZero() && !time.Now().Before(gap) {
				if !skip() {
					return
				}
			}
			if !started {
				next = job.seq
				started = true
			}
			if int16(job.seq-next) < 0 {
				continue
			}
			if _, exists := pending[job.seq]; exists {
				continue
			}
			if len(pending) == 8 {
				r.fail(receiverOverflow)
				return
			}
			pending[job.seq] = job.data
			if !flush() {
				return
			}
			if len(pending) == 0 {
				reset()
			} else if gap.IsZero() {
				reset()
			}
		}
	}
}
