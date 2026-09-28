// raya_change - Engine selection refuses incompatible authority before dialing.
package app

import (
	"context"
	"encoding/base64"
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

func TestManagerRefusesProviderMismatchBeforeAllocation(t *testing.T) {
	for _, input := range []wire.Start{
		{Version: 2, Engine: engine.Config{Provider: "unknown"}},
		{Version: 2, Engine: engine.Config{Provider: "qwen-realtime", Model: "gpt-live-1"}},
		{Version: 2, Engine: engine.Config{Provider: "openai-live", Model: "gpt-realtime-2.1"}},
		{Version: 2, Engine: engine.Config{Provider: "openai-live", Model: "gpt-live-1"}},
		{Version: 2, Engine: engine.Config{Model: "gpt-live-1"}},
		{Engine: engine.Config{Provider: "qwen-realtime"}},
		{Engine: engine.Config{Model: "gpt-live-1"}},
		{Version: 3},
	} {
		var calls atomic.Int32
		manager := NewManager(joining{join: func(context.Context) (room.Room, error) {
			calls.Add(1)
			return nil, errors.New("unexpected room allocation")
		}})
		unexpected := opening{open: func(context.Context) (engine.Session, error) {
			calls.Add(1)
			return nil, errors.New("unexpected provider allocation")
		}}
		manager.engine, manager.live = unexpected, unexpected
		input.ID = "refused"
		if _, err := manager.Start(context.Background(), input, mediaAuth); err == nil {
			t.Fatalf("incompatible engine contract accepted: %#v", input)
		}
		if calls.Load() != 0 || len(manager.sessions) != 0 {
			t.Fatal("refused provider allocated resources or retained a claim")
		}
	}
}

type formatted struct {
	media  room.Room
	rate   int
	client string
}

func (*formatted) Join(context.Context, string, string, string) (room.Room, error) {
	return nil, errors.New("unscoped room join is forbidden")
}

func (f *formatted) JoinAudioAuthorized(_ context.Context, _, _, _, client string, rate int) (room.Room, error) {
	f.rate, f.client = rate, client
	return f.media, nil
}

func TestManagerRoutesLiveThroughActualSocketAndExactInputFormat(t *testing.T) {
	for _, provider := range []string{"", "openai-live"} {
		t.Run(provider, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			received := make(chan []byte, 2)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				if request.Header.Get("Authorization") != "Bearer local-fixture" || request.URL.RawQuery != "" {
					t.Error("Live authentication or query contract changed")
				}
				conn, err := websocket.Accept(w, request, nil)
				if err != nil {
					t.Error(err)
					return
				}
				defer conn.CloseNow()
				_, raw, err := conn.Read(ctx)
				if err != nil {
					t.Error(err)
					return
				}
				var start struct {
					Type    string                     `json:"type"`
					Event   string                     `json:"event_id"`
					Session map[string]json.RawMessage `json:"session"`
				}
				if err := json.Unmarshal(raw, &start); err != nil || start.Type != "session.start" || string(start.Session["model"]) != `"gpt-live-1"` {
					t.Error("manager did not open the actual Live adapter")
					return
				}
				start.Session["id"] = json.RawMessage(`"live_fixture"`)
				ack, _ := json.Marshal(struct {
					Type    string                     `json:"type"`
					Event   string                     `json:"event_id"`
					Client  string                     `json:"client_event_id"`
					Session map[string]json.RawMessage `json:"session"`
				}{"session.started", "started", start.Event, start.Session})
				if err := conn.Write(ctx, websocket.MessageText, ack); err != nil {
					t.Error(err)
					return
				}
				for {
					_, raw, err := conn.Read(ctx)
					if err != nil {
						return
					}
					var event struct {
						Type  string `json:"type"`
						Audio string `json:"audio"`
						ID    string `json:"event_id"`
					}
					if err := json.Unmarshal(raw, &event); err != nil {
						t.Error(err)
						return
					}
					if event.Type == "session.close" {
						final, err := json.Marshal(struct {
							Type    string                     `json:"type"`
							Event   string                     `json:"event_id"`
							Client  string                     `json:"client_event_id"`
							Session map[string]json.RawMessage `json:"session"`
							Reason  string                     `json:"reason"`
							Usage   map[string]json.RawMessage `json:"usage"`
						}{"session.closed", "closed", event.ID, start.Session, "close_requested", map[string]json.RawMessage{"seconds": json.RawMessage("0.02")}})
						if err == nil {
							err = conn.Write(ctx, websocket.MessageText, final)
						}
						if err != nil {
							t.Error(err)
						}
						return
					}
					if event.Type != "session.input_audio.append" {
						t.Error("continuous voice emitted a foreign command")
						return
					}
					pcm, err := base64.StdEncoding.DecodeString(event.Audio)
					if err != nil {
						t.Error(err)
						return
					}
					received <- pcm
				}
			}))
			defer server.Close()
			media := newFakeRoom()
			factory := &formatted{media: media}
			manager := NewManager(factory)
			manager.engine = opening{open: func(context.Context) (engine.Session, error) {
				return nil, errors.New("Live silently fell back to Qwen")
			}}
			cfg := engine.Config{Provider: provider, Model: "gpt-live-1", Key: "local-fixture", Voice: "marin", Endpoint: "ws" + strings.TrimPrefix(server.URL, "http") + "/v1/live/sessions", MaximumSeconds: 10}
			started, err := manager.Start(ctx, wire.Start{Version: 2, ID: "rvs_live", Engine: cfg}, mediaAuth)
			if err != nil {
				t.Fatal(err)
			}
			defer manager.Close(started.ID, mediaAuth)
			if started.Descriptor.ID != "openai-live" || factory.rate != 24000 || factory.client != "client-rvs_live" {
				t.Fatal("selected engine and microphone authority diverged")
			}
			for _, value := range []byte{0, 64} {
				pcm := make([]byte, 960)
				for index := 1; index < len(pcm); index += 2 {
					pcm[index] = value
				}
				media.input <- engine.Frame{Rate: 24000, PCM: pcm}
				select {
				case audio := <-received:
					if len(audio) != 960 || audio[1] != value {
						t.Fatal("continuous input was gated or relabeled")
					}
				case <-ctx.Done():
					t.Fatal("actual Live socket did not receive continuous PCM")
				}
			}
			if err := manager.Close(started.ID, mediaAuth); err != nil {
				t.Fatal(err)
			}
		})
	}
}
