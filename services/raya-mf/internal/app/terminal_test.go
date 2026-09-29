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
	for _, kind := range []string{"accepted", "backend-refused", "missing-receipt", "startup-lost", "setup-refused", "startup-lost-missing-final"} {
		t.Run(kind, func(t *testing.T) {
			refused := kind == "backend-refused" || kind == "setup-refused"
			missing := kind == "missing-receipt" || kind == "startup-lost-missing-final"
			lost := kind == "startup-lost" || kind == "setup-refused" || kind == "startup-lost-missing-final"
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
			started := make(chan uint64, 1)
			var calls atomic.Int32
			var latest atomic.Uint64
			backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var event wire.Envelope
				if err := json.NewDecoder(r.Body).Decode(&event); err != nil {
					t.Error(err)
				}
				prior := latest.Swap(event.Seq)
				if event.Event.Type == "session.started" {
					started <- event.Seq
					if lost {
						<-r.Context().Done()
						return
					}
				}
				if event.Event.Type == "session.closed" || event.Event.Type == "session.setup.closed" {
					if event.Seq <= prior || event.Seq != event.Event.Seq {
						t.Error("terminal accounting did not advance beyond earlier callbacks")
					}
					calls.Add(1)
					received <- event
					if refused {
						w.Write([]byte("false"))
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
			media := newFakeRoom()
			s := NewSessionWithDescriptor(ctx, "logical_terminal", voice, media, HTTPBackend{URL: backend.URL, Control: "loopback-capability", Strict: true}, "client-logical_terminal", (live.Engine{}).Descriptor())
			var sequence uint64
			select {
			case sequence = <-started:
			case <-time.After(time.Second):
				cancel()
				t.Fatal("actual startup callback was not attempted")
			}
			if !lost {
				deadline := time.Now().Add(time.Second)
				for !s.startup.Load() && time.Now().Before(deadline) {
					time.Sleep(time.Millisecond)
				}
				if !s.startup.Load() {
					cancel()
					t.Fatal("actual strict startup HTTP ACK was not confirmed")
				}
			}
			if lost {
				// Controlled room-boundary loss, not a claimed native child crash.
				close(media.input)
			} else {
				cancel()
			}
			status := finished(t, s)
			cancel()
			err = s.Close()
			failed := refused || missing
			if (err != nil) != failed || status.BackendReport != map[bool]string{false: "succeeded", true: "failed"}[failed] {
				t.Fatalf("terminal delivery status = %#v / %v", status, err)
			}
			if missing && !lost {
				if calls.Load() != 0 {
					t.Fatal("lost final provider receipt synthesized usage")
				}
				return
			}
			select {
			case event := <-received:
				want := "session.closed"
				if lost {
					want = "session.setup.closed"
				}
				raw, _ := json.Marshal(event.Event.Data)
				if lost && missing {
					if event.Event.Type != want || event.Seq <= sequence || event.Session != "logical_terminal" || event.Event.Session != "live_terminal_fixture" || !strings.Contains(string(raw), `"event_id":"start_receipt"`) {
						t.Fatalf("known startup accounting was lost: %#v", event)
					}
					if _, exists := event.Event.Data["final"]; exists {
						t.Fatal("unknown final usage was fabricated")
					}
					break
				}
				if event.Event.Type != want || event.Seq <= sequence || event.Session != "logical_terminal" || event.Event.Session != "live_terminal_fixture" || event.Seq != event.Event.Seq || !strings.Contains(string(raw), `"event_id":"terminal_receipt"`) || !strings.Contains(string(raw), `"model":"gpt-live-1"`) || !strings.Contains(string(raw), `"seconds":0.125`) || !strings.Contains(string(raw), `"reason":"close_requested"`) || lost && !strings.Contains(string(raw), `"event_id":"start_receipt"`) {
					t.Fatalf("terminal receipt changed: %#v", event)
				}
			case <-time.After(time.Second):
				t.Fatal("confirmed terminal usage was lost after parent cancellation")
			}
			if calls.Load() != 1 {
				t.Fatalf("terminal usage replayed %d times", calls.Load())
			}
			_ = s.Close()
			if calls.Load() != 1 {
				t.Fatal("repeated Close replayed provider accounting")
			}
		})
	}
}
