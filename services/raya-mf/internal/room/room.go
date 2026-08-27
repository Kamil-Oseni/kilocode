// raya_change - LiveKit-neutral media room boundary used by Raya's frame loop.
package room

import (
	"context"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
)

type Data struct {
	Topic string
	Body  []byte
}

type Room interface {
	Input() <-chan engine.Frame
	Data() <-chan Data
	Publish(context.Context, engine.Frame) error
	Send(context.Context, Data) error
	Flush(context.Context, string) error
	Close() error
}

type Factory interface {
	Join(context.Context, string, string, string) (Room, error)
}
