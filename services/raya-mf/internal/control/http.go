// kilocode_change - new file
package control

import (
	"errors"
	"io"
	"net/http"
	"time"
)

// Limit applies to JSON control messages, not WebRTC audio.
const Limit int64 = 1 << 20

func Read(writer http.ResponseWriter, request *http.Request) ([]byte, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, Limit))
	if err == nil {
		return body, true
	}
	var limit *http.MaxBytesError
	if errors.As(err, &limit) {
		http.Error(writer, "Control request exceeds the 1 MiB limit", http.StatusRequestEntityTooLarge)
		return nil, false
	}
	http.Error(writer, "Could not read the control request", http.StatusBadRequest)
	return nil, false
}

func Server(handler http.Handler) *http.Server {
	return &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    32 << 10,
	}
}
