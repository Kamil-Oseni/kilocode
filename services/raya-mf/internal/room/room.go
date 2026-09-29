// raya_change - LiveKit-neutral media room boundary used by Raya's frame loop.
package room

import (
	"context"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
)

type Data struct {
	Identity string
	Topic    string
	Body     []byte
}

type Room interface {
	Input() <-chan engine.Frame
	Data() <-chan Data
	Publish(context.Context, engine.Frame) error
	Send(context.Context, Data) error
	Flush(context.Context, string) error
	Close() error
}

// Faults exposes fatal input failures without fabricating an audio frame or
// waiting for an uncertain native reader to finish its cleanup.
type Faults interface {
	Failure() <-chan error
}

type Factory interface {
	Join(context.Context, string, string, string) (Room, error)
}

// Authority binds microphone admission before subscription callbacks can fire.
type Authority interface {
	JoinAuthorized(context.Context, string, string, string, string) (Room, error)
}

// AudioAuthority binds the microphone decoder rate before subscriptions start.
// A continuous provider must not receive silently relabeled/resampled input.
type AudioAuthority interface {
	JoinAudioAuthorized(context.Context, string, string, string, string, int) (Room, error)
}
