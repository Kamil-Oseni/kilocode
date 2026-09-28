package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine/live"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/wire"
	"github.com/coder/websocket"
)

func TestParentCancellationDeliversExactLiveTerminalUsageToHTTPBackend(t *testing.T) {
	for _, kind := range []string{"accepted", "backend-refused", "missing-receipt"} {
		t.Run(kind, func(t *testing.T) {
			refused := kind == "backend-refused"
			missing := kind == "missing-receipt"
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := websocket.Accept(w, r, nil)
				if err != nil {
					t.Error(err)
					return
				}
				defer conn.CloseNow()
				var cfg map[string]any
				for {
					ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
					_, raw, err := conn.Read(ctx)
					cancel()
					if err != nil {
						return
					}
					var command map[string]any
					if err := json.Unmarshal(raw, &command); err != nil {
						t.Error(err)
						return
					}
					var answer map[string]any
					switch command["type"] {
					case "session.start":
						cfg = command["session"].(map[string]any)
						cfg["id"] = "live_terminal_fixture"
						answer = map[string]any{"type": "session.started", "event_id": "start_receipt", "client_event_id": command["event_id"], "session": cfg}
					case "session.close":
						if !missing {
							answer = map[string]any{"type": "session.closed", "event_id": "terminal_receipt", "client_event_id": command["event_id"], "session": cfg, "reason": "close_requested", "usage": map[string]any{"seconds": 0.125}}
						}
					}
					if answer != nil {
						raw, _ := json.Marshal(answer)
						ctx, cancel := context.WithTimeout(context.Background(), time.Second)
						err := conn.Write(ctx, websocket.MessageText, raw)
						cancel()
						if err != nil {
							return
						}
					}
				}
			}))
			defer provider.Close()
			received := make(chan wire.Envelope, 1)
			var calls atomic.Int32
			backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var event wire.Envelope
				if err := json.NewDecoder(r.Body).Decode(&event); err != nil {
					t.Error(err)
				}
				if event.Event.Type == "session.closed" {
					calls.Add(1)
					received <- event
					if refused {
						http.Error(w, "refused", http.StatusServiceUnavailable)
						return
					}
				}
				w.Write([]byte("true"))
			}))
			defer backend.Close()
			ctx, cancel := context.WithCancel(context.Background())
			voice, err := (live.Engine{}).Open(ctx, engine.Config{Endpoint: "ws" + strings.TrimPrefix(provider.URL, "http") + "/v1/live/sessions", Key: "loopback-key"})
			if err != nil {
				cancel()
				t.Fatal(err)
			}
			s := NewSessionWithDescriptor(ctx, "logical_terminal", voice, newFakeRoom(), HTTPBackend{URL: backend.URL}, "client-logical_terminal", (live.Engine{}).Descriptor())
			cancel()
			status := finished(t, s)
			err = s.Close()
			failed := refused || missing
			if (err != nil) != failed || status.BackendReport != map[bool]string{false: "succeeded", true: "failed"}[failed] {
				t.Fatalf("terminal delivery status = %#v / %v", status, err)
			}
			if missing {
				if calls.Load() != 0 {
					t.Fatal("lost final provider receipt synthesized usage")
				}
				return
			}
			select {
			case event := <-received:
				raw, _ := json.Marshal(event.Event.Data)
				if event.Session != "logical_terminal" || event.Event.Session != "live_terminal_fixture" || event.Seq != event.Event.Seq || !strings.Contains(string(raw), `"event_id":"terminal_receipt"`) || !strings.Contains(string(raw), `"model":"gpt-live-1"`) || !strings.Contains(string(raw), `"seconds":0.125`) || !strings.Contains(string(raw), `"reason":"close_requested"`) {
					t.Fatalf("terminal receipt changed: %#v", event)
				}
			case <-time.After(time.Second):
				t.Fatal("confirmed terminal usage was lost after parent cancellation")
			}
			if calls.Load() != 1 {
				t.Fatalf("terminal usage replayed %d times", calls.Load())
			}
		})
	}
}
