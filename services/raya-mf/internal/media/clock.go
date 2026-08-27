// raya_change - Non-blocking 20 ms frame clock with deterministic silence insertion.
package media

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
)

type Chunk struct {
	Item string
	PCM  []byte
}

type Clock struct {
	rate      int
	size      int
	input     chan Chunk
	output    chan engine.Frame
	frames    atomic.Uint64
	underruns atomic.Uint64
}

func NewClock(rate int) *Clock {
	return &Clock{
		rate:   rate,
		size:   rate * 2 * int(engine.FramePeriod/time.Millisecond) / 1000,
		input:  make(chan Chunk, 64),
		output: make(chan engine.Frame, 8),
	}
}

func (c *Clock) Input() chan<- Chunk {
	return c.input
}

func (c *Clock) Output() <-chan engine.Frame {
	return c.output
}

func (c *Clock) Stats() (uint64, uint64) {
	return c.frames.Load(), c.underruns.Load()
}

func (c *Clock) Run(ctx context.Context) {
	ticker := time.NewTicker(engine.FramePeriod)
	defer ticker.Stop()
	c.run(ctx, ticker.C)
}

func (c *Clock) RunWithTicks(ctx context.Context, ticks <-chan time.Time) {
	c.run(ctx, ticks)
}

func (c *Clock) run(ctx context.Context, ticks <-chan time.Time) {
	defer close(c.output)
	queue := make([]byte, 0, c.size*6)
	item := ""
	for {
		select {
		case <-ctx.Done():
			return
		case chunk := <-c.input:
			queue = append(queue, chunk.PCM...)
			if chunk.Item != "" {
				item = chunk.Item
			}
		case at, ok := <-ticks:
			if !ok {
				return
			}
			pcm := make([]byte, c.size)
			if len(queue) >= c.size {
				copy(pcm, queue[:c.size])
				queue = queue[c.size:]
			} else {
				copy(pcm, queue)
				queue = queue[:0]
				c.underruns.Add(1)
			}
			c.frames.Add(1)
			frame := engine.Frame{Item: item, PCM: pcm, Rate: c.rate, At: at}
			select {
			case c.output <- frame:
			default:
				c.underruns.Add(1)
			}
		}
	}
}
