// raya_change - Actual HTTP control and GPT-Live WS ACKs with a synthetic silent room boundary.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/app"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/control"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/room"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/wire"
	"github.com/coder/websocket"
)

type silent struct {
	input chan engine.Frame
	data  chan room.Data
}

func (s *silent) Join(context.Context, string, string, string) (room.Room, error) {
	return nil, errors.New("unversioned room not authorized")
}
func (s *silent) JoinAudioAuthorized(_ context.Context, _, _, _, _ string, rate int) (room.Room, error) {
	if rate != 24000 {
		return nil, errors.New("wrong rate")
	}
	return s, nil
}
func (s *silent) Input() <-chan engine.Frame { return s.input }
func (s *silent) Data() <-chan room.Data     { return s.data }
func (*silent) Publish(_ context.Context, frame engine.Frame) error {
	if frame.Item != "" {
		return errors.New("fixture has no acoustic output")
	}
	return nil
}
func (*silent) Send(context.Context, room.Data) error { return nil }
func (*silent) Flush(context.Context, string) error   { return nil }
func (*silent) Close() error                          { return nil }

func TestResultVersionTwoExactACKThroughActualManagerAndLiveSocket(t *testing.T) {
	events := make(chan wire.Envelope, 16)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var event wire.Envelope
		if err := json.NewDecoder(r.Body).Decode(&event); err != nil {
			t.Error(err)
			http.Error(w, "invalid", 400)
			return
		}
		select {
		case events <- event:
		default:
			t.Error("callback observer full")
		}
		_, _ = w.Write([]byte("true"))
	}))
	defer backend.Close()
	commands := make(chan map[string]any, 8)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/live/sessions" || r.Header.Get("Authorization") != "Bearer loopback-result-key" {
			http.Error(w, "invalid provider boundary", 400)
			return
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.CloseNow()
		var config map[string]any
		for {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			_, raw, err := conn.Read(ctx)
			cancel()
			if err != nil {
				return
			}
			var value map[string]any
			if err := json.Unmarshal(raw, &value); err != nil {
				t.Error(err)
				return
			}
			var answer map[string]any
			switch value["type"] {
			case "session.start":
				config = value["session"].(map[string]any)
				config["id"] = "provider_result"
				answer = map[string]any{"type": "session.started", "event_id": "started_result", "client_event_id": value["event_id"], "session": config}
			case "session.commentary.append":
				commands <- value
				answer = map[string]any{"type": "session.commentary.appended", "event_id": "ack_" + value["event_id"].(string), "client_event_id": value["event_id"], "start_ms": 1, "end_ms": 2}
			case "session.close":
				answer = map[string]any{"type": "session.closed", "event_id": "closed_result", "client_event_id": value["event_id"], "session": config, "reason": "close_requested", "usage": map[string]any{"seconds": 0.02}}
			}
			if answer == nil {
				continue
			}
			raw, _ = json.Marshal(answer)
			ctx, cancel = context.WithTimeout(context.Background(), time.Second)
			err = conn.Write(ctx, websocket.MessageText, raw)
			cancel()
			if err != nil {
				return
			}
			if value["type"] == "session.start" {
				raw, _ = json.Marshal(map[string]any{"type": "session.delegation.created", "event_id": "delegated_result", "offset_ms": 1, "delegation": map[string]any{"id": "original_result", "type": "delegation", "target": "client"}})
				ctx, cancel = context.WithTimeout(context.Background(), time.Second)
				err = conn.Write(ctx, websocket.MessageText, raw)
				cancel()
				if err != nil {
					return
				}
			}
		}
	}))
	defer provider.Close()
	key, err := control.ParseKey(routeToken)
	if err != nil {
		t.Fatal(err)
	}
	manager := app.NewManager(&silent{input: make(chan engine.Frame), data: make(chan room.Data)})
	server := httptest.NewServer(routes(manager, key))
	defer server.Close()
	defer func() {
		if err := manager.CloseAll(); err != nil {
			t.Error(err)
		}
	}()
	request := func(path string, value interface{}, token string) (int, map[string]interface{}) {
		t.Helper()
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequest(http.MethodPost, server.URL+path, strings.NewReader(string(raw)))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("X-Raya-Media-Key", routeToken)
		req.Header.Set("Authorization", "Bearer "+token)
		response, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var body map[string]interface{}
		if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, body
	}
	status, _ := request("/v1/sessions", wire.Start{Version: 2, ID: "media_result", BackendURL: backend.URL, Engine: engine.Config{Provider: "openai-live", Endpoint: "ws" + strings.TrimPrefix(provider.URL, "http") + "/v1/live/sessions", Key: "loopback-result-key", Delegation: "client", MaximumSeconds: 10}}, routeToken)
	if status != http.StatusCreated {
		t.Fatal("actual Live manager failed admission", status)
	}
	end := time.After(time.Second)
	for {
		select {
		case event := <-events:
			if event.Event.Type == "session.delegation.created" {
				goto registered
			}
		case <-end:
			t.Fatal("original delegation did not cross actual authenticated callback")
		}
	}
registered:
	for _, version := range []int{2, 1} {
		receipt := []string{"receipt_v1", "receipt_v2"}[version-1]
		input := map[string]interface{}{"version": version, "delegationID": "original_result", "receiptID": receipt, "kind": "commentary", "content": "Task result", "ttl": 1000, "created": time.Now().UTC().Format(time.RFC3339Nano)}
		status, body := request("/v1/sessions/media_result/result", input, routeToken)
		if status != http.StatusAccepted || body["accepted"] != true || body["played"] != false {
			t.Fatal("actual provider ACK did not produce acceptance only", status, body)
		}
		if version == 2 {
			if len(body) != 6 || body["version"] != float64(2) || body["sessionID"] != "media_result" || body["delegationID"] != "original_result" || body["receiptID"] != receipt {
				t.Fatal("version two ACK lost exact identity", body)
			}
		}
		if version == 1 && len(body) != 2 {
			t.Fatal("version one compatibility changed", body)
		}
		select {
		case command := <-commands:
			if command["delegation_id"] != "original_result" || command["content"] != "Task result" || command["event_id"] == receipt {
				t.Fatal("provider command mismatched result identity", command)
			}
		case <-time.After(time.Second):
			t.Fatal("accepted route fabricated a provider ACK")
		}
		status, body = request("/v1/sessions/media_result/result", input, routeToken)
		if status != http.StatusAccepted {
			t.Fatal("exact retry lost accepted immutable receipt", body)
		}
		status, _ = request("/v1/sessions/media_result/result", input, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
		if status != http.StatusUnauthorized {
			t.Fatal("wrong session capability admitted result", status)
		}
	}
	select {
	case command := <-commands:
		t.Fatal("retry/unauthorized request resent provider result", command)
	case <-time.After(25 * time.Millisecond):
	}
}
