//go:build !cgo

// raya_change - Explicit codec capability failure outside the containerized libopus build.
package livekit

import (
	"context"
	"errors"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/room"
)

type Factory struct{}

func (Factory) Join(context.Context, string, string, string) (room.Room, error) {
	return nil, errors.New("LiveKit PCM requires the containerized CGO/libopus raya-mf build")
}
