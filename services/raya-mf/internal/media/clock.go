// raya_change - Bounded, item-attributed, non-blocking 20 ms frame scheduling.
package media

import (
	"context"
	"errors"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"sync"
	"sync/atomic"
	"time"
)

const queued = 5 // 100 ms PCM + one 20 ms output frame; no adaptive jitter claim.
const identities = 256

var ErrClosed = errors.New("media clock is closed")
var ErrCapacity = errors.New("media clock cancellation allowance exhausted")

type Chunk struct {
	Item  string
	PCM   []byte
	Epoch uint64
	start uint64
	owned bool
	slots int
}
type Loss struct {
	DroppedBytes  uint64
	DroppedFrames uint64
	InvalidChunks uint64
	QueuedBytes   uint64
}
type discard struct {
	item string
	ack  chan error
}
type Clock struct {
	rate      int
	size      int
	input     chan Chunk
	output    chan engine.Frame
	control   chan discard
	done      chan struct{}
	mu        sync.Mutex
	closed    bool
	ended     bool
	inbound   uint64
	pending   int
	offsets   map[string]uint64
	blocked   map[string]bool
	epoch     atomic.Uint64
	started   atomic.Bool
	frames    atomic.Uint64
	underruns atomic.Uint64
	bytes     atomic.Uint64
	drops     atomic.Uint64
	invalid   atomic.Uint64
	buffered  atomic.Uint64
}

func NewClock(rate int) *Clock {
	size := 0
	if rate >= 8000 && rate <= 96000 && rate%50 == 0 {
		size = rate * 2 / 50
	}
	c := &Clock{rate: rate, size: size, input: make(chan Chunk, 6), output: make(chan engine.Frame, 1), control: make(chan discard, 8), done: make(chan struct{}), offsets: make(map[string]uint64), blocked: make(map[string]bool)}
	c.epoch.Store(1)
	return c
}

// Legacy Input borrows slices; use Submit for bounded owned production ingress.
func (c *Clock) Input() chan<- Chunk         { return c.input }
func (c *Clock) Output() <-chan engine.Frame { return c.output }
func (c *Clock) Stats() (uint64, uint64)     { return c.frames.Load(), c.underruns.Load() }
func (c *Clock) Loss() Loss {
	c.mu.Lock()
	defer c.mu.Unlock()
	return Loss{c.bytes.Load(), c.drops.Load(), c.invalid.Load(), c.inbound + c.buffered.Load()}
}

// Submit rejects oversized bursts atomically. Loss never means published/heard.
func (c *Clock) Submit(chunk Chunk) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.ended {
		return false
	}
	chunk, ok := c.admit(chunk)
	if !ok {
		return false
	}
	chunk.slots = (len(chunk.PCM) + c.size - 1) / c.size
	if c.pending+chunk.slots > queued {
		c.bytes.Add(uint64(len(chunk.PCM)))
		return false
	}
	chunk.PCM = append([]byte(nil), chunk.PCM...)
	chunk.owned = true
	if !c.enqueue(chunk) {
		return false
	}
	c.inbound += uint64(len(chunk.PCM))
	c.pending += chunk.slots
	return true
}

// Only this send can panic if a compatibility producer closes Input. Convert
// that channel lifecycle race into explicit refusal, never crash the clock.
func (c *Clock) enqueue(chunk Chunk) (ok bool) {
	defer func() {
		if recover() != nil {
			c.ended = true
			c.invalid.Add(1)
			c.bytes.Add(uint64(len(chunk.PCM)))
		}
	}()
	select {
	case c.input <- chunk:
		return true
	default:
		c.bytes.Add(uint64(len(chunk.PCM)))
		return false
	}
}

// Drop returns an applied local cancellation ACK, not client playback. A timed
// out waiter cannot undo a queued cancellation; callers must fail closed.
func (c *Clock) Drop(ctx context.Context, item string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if item != "" && !identifier(item) {
		return errors.New("invalid media item")
	}
	command := discard{item, make(chan error, 1)}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-c.done:
		select {
		case err := <-command.ack:
			return err
		default:
			return ErrClosed
		}
	case c.control <- command:
	}
	select {
	case err := <-command.ack:
		return err
	case <-ctx.Done():
		return ctx.Err()
	case <-c.done:
		select {
		case err := <-command.ack:
			return err
		default:
			return ErrClosed
		}
	}
}

// Under mu. Even rejected overflow advances original generated sample offsets.
func (c *Clock) admit(chunk Chunk) (Chunk, bool) {
	if c.size == 0 || !identifier(chunk.Item) || len(chunk.PCM) == 0 || len(chunk.PCM)%2 != 0 {
		c.invalid.Add(1)
		c.bytes.Add(uint64(len(chunk.PCM)))
		return chunk, false
	}
	if c.blocked[chunk.Item] || (chunk.Epoch != 0 && chunk.Epoch != c.epoch.Load()) {
		c.bytes.Add(uint64(len(chunk.PCM)))
		return chunk, false
	}
	prior, exists := c.offsets[chunk.Item]
	if (!exists && len(c.offsets) >= identities) || uint64(len(chunk.PCM)/2) > ^uint64(0)-prior {
		c.invalid.Add(1)
		c.bytes.Add(uint64(len(chunk.PCM)))
		return chunk, false
	}
	chunk.start = prior
	c.offsets[chunk.Item] = prior + uint64(len(chunk.PCM)/2)
	chunk.Epoch = c.epoch.Load()
	if len(chunk.PCM) > c.size*queued {
		c.bytes.Add(uint64(len(chunk.PCM)))
		return chunk, false
	}
	return chunk, true
}
func (c *Clock) Run(ctx context.Context) {
	ticker := time.NewTicker(engine.FramePeriod)
	defer ticker.Stop()
	c.run(ctx, ticker.C)
}
func (c *Clock) RunWithTicks(ctx context.Context, ticks <-chan time.Time) { c.run(ctx, ticks) }

func (c *Clock) run(ctx context.Context, ticks <-chan time.Time) {
	if !c.started.CompareAndSwap(false, true) {
		return
	}
	defer func() {
		c.mu.Lock()
		c.closed = true
		for range cap(c.input) {
			select {
			case chunk, open := <-c.input:
				if open {
					c.bytes.Add(uint64(len(chunk.PCM)))
				}
			default:
			}
		}
		c.inbound = 0
		c.pending = 0
		c.mu.Unlock()
		c.bytes.Add(c.buffered.Load())
		c.buffered.Store(0)
		c.drain()
		close(c.output)
		close(c.done)
	}()
	if c.size == 0 {
		c.invalid.Add(1)
		return
	}
	input := (<-chan Chunk)(c.input)
	queue := make([]Chunk, 0, queued)
	bytes := 0
	accept := func(chunk Chunk) {
		c.mu.Lock()
		defer c.mu.Unlock()
		ok := true
		if chunk.owned {
			c.inbound -= uint64(len(chunk.PCM))
		}
		if !chunk.owned {
			chunk, ok = c.admit(chunk)
		}
		if ok && (chunk.Epoch != c.epoch.Load() || c.blocked[chunk.Item]) {
			c.bytes.Add(uint64(len(chunk.PCM)))
			ok = false
		}
		if !ok {
			if chunk.owned {
				c.pending -= chunk.slots
			}
			return
		}
		if !chunk.owned {
			chunk.slots = (len(chunk.PCM) + c.size - 1) / c.size
			if c.pending+chunk.slots > queued {
				c.bytes.Add(uint64(len(chunk.PCM)))
				return
			}
			c.pending += chunk.slots
		}
		if len(queue) >= queued {
			c.pending -= chunk.slots
			c.bytes.Add(uint64(len(chunk.PCM)))
			return
		}
		if !chunk.owned {
			chunk.PCM = append([]byte(nil), chunk.PCM...)
		}
		queue = append(queue, chunk)
		bytes += len(chunk.PCM)
		c.buffered.Store(uint64(bytes))
	}
	drop := func(command discard) bool {
		c.mu.Lock()
		count := len(c.blocked)
		if command.item == "" {
			for item := range c.offsets {
				if !c.blocked[item] {
					count++
				}
			}
		} else if !c.blocked[command.item] {
			count++
		}
		if c.epoch.Load() == ^uint64(0) || count > identities {
			c.mu.Unlock()
			command.ack <- ErrCapacity
			return false
		}
		if command.item == "" {
			for item := range c.offsets {
				c.blocked[item] = true
			}
		} else {
			c.blocked[command.item] = true
		}
		c.epoch.Add(1)
		// Drain old-epoch ingress while Submit is excluded. New-epoch admission
		// begins only after this local flush has finished.
		for range cap(c.input) {
			select {
			case chunk, open := <-input:
				if !open {
					input = nil
					c.ended = true
				} else {
					if chunk.owned {
						c.inbound -= uint64(len(chunk.PCM))
					}
					c.bytes.Add(uint64(len(chunk.PCM)))
				}
			default:
			}
		}
		c.bytes.Add(uint64(bytes))
		clear(queue)
		queue = queue[:0]
		bytes = 0
		c.buffered.Store(0)
		c.pending = 0
		c.mu.Unlock()
		c.drain()
		command.ack <- nil
		return true
	}
	var seq uint64
	emit := func(at time.Time) bool {
		for range cap(c.input) {
			select {
			case chunk, open := <-input:
				if !open {
					input = nil
					c.mu.Lock()
					c.ended = true
					c.mu.Unlock()
				} else {
					accept(chunk)
				}
			default:
			}
		}
		if seq == ^uint64(0) {
			return false
		}
		seq++
		frame := engine.Frame{PCM: make([]byte, c.size), Rate: c.rate, At: at, Epoch: c.epoch.Load(), Seq: seq}
		used := 0
		if len(queue) > 0 {
			frame.Item = queue[0].Item
			frame.Start = queue[0].start
		}
		for len(queue) > 0 && queue[0].Item == frame.Item && used < c.size {
			chunk := &queue[0]
			if chunk.start != frame.Start+uint64(used/2) {
				break
			}
			n := min(c.size-used, len(chunk.PCM))
			copy(frame.PCM[used:], chunk.PCM[:n])
			used += n
			bytes -= n
			chunk.start += uint64(n / 2)
			chunk.PCM = chunk.PCM[n:]
			slots := (len(chunk.PCM) + c.size - 1) / c.size
			c.mu.Lock()
			c.pending -= chunk.slots - slots
			chunk.slots = slots
			c.buffered.Store(uint64(bytes))
			c.mu.Unlock()
			if len(chunk.PCM) == 0 {
				queue[0] = Chunk{}
				queue = queue[1:]
			}
		}
		if used < c.size {
			c.underruns.Add(1)
		}
		if used > 0 {
			frame.End = frame.Start + uint64(used/2)
		}
		c.buffered.Store(uint64(bytes))
		c.frames.Add(1)
		select {
		case c.output <- frame:
		default:
			c.drain()
			select {
			case c.output <- frame:
			default:
				c.drops.Add(1)
				c.bytes.Add(uint64(used))
			}
		}
		return true
	}
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		select {
		case command := <-c.control:
			if !drop(command) {
				return
			}
			continue
		default:
		}
		// Prioritize a waiting clock tick over continuously arriving vendor bursts.
		select {
		case at, ok := <-ticks:
			if !ok || !emit(at) {
				return
			}
			continue
		default:
		}
		select {
		case <-ctx.Done():
			return
		case command := <-c.control:
			if !drop(command) {
				return
			}
		case chunk, ok := <-input:
			if !ok {
				input = nil
				c.mu.Lock()
				c.ended = true
				c.mu.Unlock()
			} else {
				accept(chunk)
			}
		case at, ok := <-ticks:
			if !ok {
				return
			}
			if !emit(at) {
				return
			}
		}
	}
}
func (c *Clock) drain() {
	for {
		select {
		case frame := <-c.output:
			c.drops.Add(1)
			c.bytes.Add((frame.End - frame.Start) * 2)
		default:
			return
		}
	}
}
func identifier(item string) bool {
	if len(item) == 0 || len(item) > 128 {
		return false
	}
	for _, char := range item {
		if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '_' || char == '-') {
			return false
		}
	}
	return true
}
