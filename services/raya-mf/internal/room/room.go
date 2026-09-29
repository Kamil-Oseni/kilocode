// raya_change - LiveKit-neutral media room boundary used by Raya's frame loop.
package room

import (
	"context"
	"errors"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
)

var ErrCleanupUnknown = errors.New("native transport termination is unconfirmed")

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

// Cleanup proves actual resource termination, independently of provider usage
// settlement. Err is meaningful only after Done closes.
type Cleanup interface {
	Done() <-chan struct{}
	Err() error
}

// SetupError retains the exact failed or cancelled native operation until its
// actual cleanup finishes. Cancellation is not a termination receipt.
type SetupError struct {
	Cause   error
	Cleanup Cleanup
}

func (e *SetupError) Error() string { return e.Cause.Error() }
func (e *SetupError) Unwrap() error { return e.Cause }

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
