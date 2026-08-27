// raya_change - Raya media frontend process: control stays HTTP while audio stays WebRTC.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/app"
	lkroom "github.com/Kilo-Org/kilocode/services/raya-mf/internal/room/livekit"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/wire"
)

func main() {
	manager := app.NewManager(lkroom.Factory{})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(writer http.ResponseWriter, _ *http.Request) {
		write(writer, http.StatusOK, map[string]any{"ok": true, "service": "raya-mf"})
	})
	mux.HandleFunc("POST /v1/sessions", func(writer http.ResponseWriter, request *http.Request) {
		var input wire.Start
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			write(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		started, err := manager.Start(request.Context(), input)
		if err != nil {
			write(writer, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		write(writer, http.StatusCreated, started)
	})
	mux.HandleFunc("POST /v1/sessions/{id}/inject", func(writer http.ResponseWriter, request *http.Request) {
		var input wire.Inject
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			write(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if err := manager.Inject(request.Context(), request.PathValue("id"), input.Item); err != nil {
			write(writer, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		write(writer, http.StatusAccepted, map[string]any{"accepted": true})
	})
	mux.HandleFunc("DELETE /v1/sessions/{id}", func(writer http.ResponseWriter, request *http.Request) {
		if err := manager.Close(request.PathValue("id")); err != nil {
			write(writer, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		write(writer, http.StatusOK, map[string]any{"closed": true})
	})

	addr := os.Getenv("RAYA_MF_ADDR")
	if addr == "" {
		addr = "127.0.0.1:7890"
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		panic(err)
	}
	server := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	go func() {
		slog.Info("raya media frontend ready", "address", listener.Addr().String())
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("media frontend failed", "error", err)
			stop()
		}
	}()
	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdown)
	_ = manager.CloseAll()
}

func write(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	if err := json.NewEncoder(writer).Encode(value); err != nil {
		slog.Error("failed to write response", "error", err)
	}
}
