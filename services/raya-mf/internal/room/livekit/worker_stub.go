//go:build !cgo

// raya_change - The production media worker requires native libopus.
package livekit

import (
	"errors"
	"io"
)

func Worker(io.ReadCloser, io.WriteCloser) error { return errors.New("native") }
