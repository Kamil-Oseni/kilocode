package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/room"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/wire"
	"github.com/coder/websocket"
)

type setupRooms struct{ joining }

func (s setupRooms) JoinAudioAuthorized(ctx context.Context, _, _, _, _ string, rate int) (room.Room, error) {
	if rate != 24000 {
		return nil, errors.New("unexpected Live input rate")
	}
	return s.join(ctx)
}

func setupProvider(t *testing.T, final bool, ready ...bool) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	count := &atomic.Int32{}
	sockets := make(chan *websocket.Conn, 8)
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count.Add(1)
		if r.URL.Path != "/v1/live/sessions" || r.Header.Get("Authorization") != "Bearer setup-key" {
			http.Error(w, "invalid", 400)
			return
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		sockets <- conn
		defer conn.CloseNow()
		var config map[string]any
		for {
			_, raw, err := conn.Read(context.Background())
			if err != nil {
				return
			}
			var value map[string]any
			if json.Unmarshal(raw, &value) != nil {
				return
			}
			var answer map[string]any
			switch value["type"] {
			case "session.start":
				config = value["session"].(map[string]any)
				config["id"] = "live_setup"
				if len(ready) != 0 && !ready[0] {
					continue
				}
				answer = map[string]any{"type": "session.started", "event_id": "setup_started", "client_event_id": value["event_id"], "session": config}
			case "session.close":
				if !final {
					continue
				}
				answer = map[string]any{"type": "session.closed", "event_id": "setup_final", "client_event_id": value["event_id"], "session": config, "reason": "close_requested", "usage": map[string]any{"seconds": 0.03}}
			}
			if answer == nil {
				continue
			}
			data, err := json.Marshal(answer)
			if err != nil || conn.Write(context.Background(), websocket.MessageText, data) != nil {
				return
			}
		}
	}))
	t.Cleanup(func() {
		for {
			select {
			case conn := <-sockets:
				_ = conn.CloseNow()
			default:
				site.Close()
				return
			}
		}
	})
	return site, count
}

func TestManagerLiveOpenWithoutStartupRetainsUnknownWithoutCallbackOrRedial(t *testing.T) {
	provider, count := setupProvider(t, true, false)
	var callbacks atomic.Int32
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var event wire.Envelope
		if json.NewDecoder(r.Body).Decode(&event) != nil || event.Session != "rvs_setup" || event.Event.Session != "live_setup" || event.Event.Type != "session.setup.closed" || r.Header.Get("X-Raya-Voice-Capability") != mediaAuth {
			t.Error("cancelled setup lost exact authenticated provider identity")
		}
		callbacks.Add(1)
		_, _ = w.Write([]byte("true"))
	}))
	defer backend.Close()
	manager := NewManager(setupRooms{joining{join: func(context.Context) (room.Room, error) {
		t.Fatal("room joined without startup ACK")
		return nil, errors.New("unconfirmed")
	}}})
	manager.timeout = 30 * time.Millisecond
	input := setupInput(provider.URL, backend.URL)
	if _, err := manager.Start(context.Background(), input, mediaAuth); err == nil {
		t.Fatal("missing startup was accepted")
	}
	if _, retained, err := manager.Status(input.ID, mediaAuth); err != nil || !retained {
		t.Fatal("unknown provider open lost ownership")
	}
	if _, err := manager.Start(context.Background(), input, mediaAuth); err == nil {
		t.Fatal("unknown provider open allowed redial")
	}
	if callbacks.Load() != 0 || count.Load() != 1 {
		t.Fatal("missing provider identity was invented or replayed")
	}
}

func setupInput(provider, backend string) wire.Start {
	return wire.Start{Version: 2, ID: "rvs_setup", BackendURL: backend, BackendAuth: "Basic setup", Directory: "workspace setup",
		Engine: engine.Config{Provider: "openai-live", Endpoint: "ws" + strings.TrimPrefix(provider, "http") + "/v1/live/sessions", Key: "setup-key", Model: "gpt-live-1", Delegation: "client", MaximumSeconds: 10}}
}

func TestManagerFailedLiveJoinSettlesExactSetupReceipt(t *testing.T) {
	for _, mode := range []string{"confirmed", "false", "missing", "malformed", "503", "lostfinal"} {
		t.Run(mode, func(t *testing.T) {
			provider, count := setupProvider(t, mode != "lostfinal")
			callbacks := make(chan wire.Envelope, 2)
			backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Basic setup" || r.Header.Get("X-Raya-Voice-Capability") != mediaAuth || r.URL.Query().Get("directory") != "workspace setup" {
					t.Error("setup callback lost exact authenticated scope")
				}
				var event wire.Envelope
				if json.NewDecoder(r.Body).Decode(&event) != nil {
					t.Error("invalid callback")
				}
				callbacks <- event
				switch mode {
				case "false":
					_, _ = w.Write([]byte("false"))
				case "missing":
					w.WriteHeader(204)
				case "malformed":
					_, _ = w.Write([]byte("true false"))
				case "503":
					w.WriteHeader(503)
				default:
					_, _ = w.Write([]byte("true"))
				}
			}))
			defer backend.Close()
			failure := errors.New("controlled room Join failed")
			manager := NewManager(setupRooms{joining{join: func(context.Context) (room.Room, error) { return nil, failure }}})
			input := setupInput(provider.URL, backend.URL)
			_, err := manager.Start(context.Background(), input, mediaAuth)
			if !errors.Is(err, failure) {
				t.Fatalf("original Join failure lost: %v", err)
			}
			select {
			case event := <-callbacks:
				if event.Session != input.ID || event.Event.Session != "live_setup" || event.Event.Type != "session.setup.closed" {
					t.Fatalf("setup receipt identity changed: %#v", event)
				}
				raw, _ := json.Marshal(event.Event.Data)
				var data struct {
					Version int
					Started struct {
						Event string `json:"event_id"`
						Model string
					}
					Final *struct {
						Event  string `json:"event_id"`
						Model  string
						Reason string
						Usage  struct{ Seconds float64 }
					}
				}
				if json.Unmarshal(raw, &data) != nil || data.Version != 1 || data.Started.Event != "setup_started" || data.Started.Model != "gpt-live-1" {
					t.Fatal("exact startup receipt was not retained")
				}
				if mode == "lostfinal" {
					if data.Final != nil {
						t.Fatal("missing final usage was fabricated")
					}
				} else if data.Final == nil || data.Final.Event != "setup_final" || data.Final.Model != "gpt-live-1" || data.Final.Usage.Seconds != 0.03 {
					t.Fatal("exact provider final usage changed")
				}
			default:
				t.Fatal("setup settlement was not delivered before Start returned")
			}
			_, retained, status := manager.Status(input.ID, mediaAuth)
			if status != nil || retained != (mode != "confirmed") {
				t.Fatalf("setup ownership retention = %t, %v", retained, status)
			}
			if mode != "confirmed" {
				if _, err := manager.Start(context.Background(), input, mediaAuth); err == nil {
					t.Fatal("unknown setup allowed replacement")
				}
				if err := manager.Close(input.ID, mediaAuth); err == nil {
					t.Fatal("unknown setup cleanup was reported confirmed")
				}
			}
			if count.Load() != 1 {
				t.Fatal("failed settlement replayed provider Dial")
			}
			select {
			case <-callbacks:
				t.Fatal("setup settlement callback was replayed")
			default:
			}
		})
	}
}

func TestManagerLiveSharedBudgetAndRequestCancellationFenceHeldJoin(t *testing.T) {
	for _, mode := range []string{"budget", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			provider, count := setupProvider(t, true)
			var callbacks atomic.Int32
			backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var event wire.Envelope
				if json.NewDecoder(r.Body).Decode(&event) != nil || event.Session != "rvs_setup" || event.Event.Session != "live_setup" || event.Event.Type != "session.setup.closed" || r.Header.Get("X-Raya-Voice-Capability") != mediaAuth {
					t.Error("cancelled setup lost exact authenticated provider identity")
				}
				callbacks.Add(1)
				_, _ = w.Write([]byte("true"))
			}))
			defer backend.Close()
			entered := make(chan struct{})
			manager := NewManager(setupRooms{joining{join: func(ctx context.Context) (room.Room, error) { close(entered); <-ctx.Done(); return nil, ctx.Err() }}})
			input := setupInput(provider.URL, backend.URL)
			if mode == "budget" {
				input.Engine.MaximumSeconds = 1.5
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			begin := time.Now()
			go func() { _, err := manager.Start(ctx, input, mediaAuth); done <- err }()
			<-entered
			if mode == "cancel" {
				cancel()
			}
			err := result(t, done)
			if mode == "budget" && !errors.Is(err, ErrSetupTimeout) {
				t.Fatalf("shared reserved deadline lost: %v", err)
			}
			if mode == "cancel" && !errors.Is(err, context.Canceled) {
				t.Fatalf("request cancellation lost: %v", err)
			}
			if time.Since(begin) > 2*time.Second || callbacks.Load() != 1 || count.Load() != 1 {
				t.Fatal("cancelled Join lost bounded exact settlement or redialed")
			}
			if _, retained, err := manager.Status(input.ID, mediaAuth); err != nil || retained {
				t.Fatal("confirmed failed setup retained resources")
			}
		})
	}
}
