// raya_change - Actual HTTP control and GPT-Live WS ACKs with a synthetic silent room boundary.
package main

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

type journey struct {
	request  func(string, string, any, string) (int, map[string]any)
	events   <-chan wire.Envelope
	commands <-chan map[string]any
	inputs   <-chan map[string]any
	input    chan engine.Frame
	conn     *websocket.Conn
	dials    *atomic.Int32
}

func travel(t *testing.T) *journey {
	t.Helper()
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
	t.Cleanup(backend.Close)
	commands := make(chan map[string]any, 8)
	inputs := make(chan map[string]any, 4)
	peers := make(chan *websocket.Conn, 1)
	dials := &atomic.Int32{}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		dials.Add(1)
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
		peers <- conn
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
			case "session.input_audio.append":
				inputs <- value
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
	t.Cleanup(provider.Close)
	key, err := control.ParseKey(routeToken)
	if err != nil {
		t.Fatal(err)
	}
	input := make(chan engine.Frame, 1)
	manager := app.NewManager(&silent{input: input, data: make(chan room.Data)})
	server := httptest.NewServer(routes(manager, key))
	t.Cleanup(server.Close)
	t.Cleanup(func() {
		if err := manager.CloseAll(); err != nil {
			t.Error(err)
		}
	})
	request := func(method, path string, value any, token string) (int, map[string]any) {
		t.Helper()
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequest(method, server.URL+path, strings.NewReader(string(raw)))
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
		var body map[string]any
		if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, body
	}
	status, _ := request(http.MethodPost, "/v1/sessions", wire.Start{Version: 2, ID: "media_result", BackendURL: backend.URL, Engine: engine.Config{Provider: "openai-live", Endpoint: "ws" + strings.TrimPrefix(provider.URL, "http") + "/v1/live/sessions", Key: "loopback-result-key", Delegation: "client", MaximumSeconds: 10}}, routeToken)
	if status != http.StatusCreated {
		t.Fatal("actual Live manager failed admission", status)
	}
	return &journey{request: request, events: events, commands: commands, inputs: inputs, input: input, conn: <-peers, dials: dials}
}

func (j *journey) observed(t *testing.T, kind string) wire.Envelope {
	t.Helper()
	end := time.After(time.Second)
	for {
		select {
		case event := <-j.events:
			if strings.HasPrefix(event.Event.Type, "transcript.") {
				t.Fatal("fixture unexpectedly injected a user caption")
			}
			if event.Event.Type == kind {
				return event
			}
		case <-end:
			t.Fatal("missing actual callback", kind)
		}
	}
}

func TestResultVersionTwoExactACKThroughActualManagerAndLiveSocket(t *testing.T) {
	j := travel(t)
	j.observed(t, "session.delegation.created")
	request := func(path string, value any, token string) (int, map[string]any) {
		return j.request(http.MethodPost, path, value, token)
	}
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
		case command := <-j.commands:
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
	case command := <-j.commands:
		t.Fatal("retry/unauthorized request resent provider result", command)
	case <-time.After(25 * time.Millisecond):
	}
}

func TestCaptionFreeClarificationKeepsMediaAndAcceptsFreshDelegation(t *testing.T) {
	j := travel(t)
	original := j.observed(t, "session.delegation.created")
	if original.Event.Item != "original_result" {
		t.Fatal("fixture lost original provider delegation")
	}
	for index, id := range []string{"original_result", "fresh_result"} {
		if index == 1 {
			event := map[string]any{"type": "session.delegation.created", "event_id": "delegated_fresh", "offset_ms": 3, "delegation": map[string]any{"id": id, "type": "delegation", "target": "client"}}
			raw, err := json.Marshal(event)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			err = j.conn.Write(ctx, websocket.MessageText, raw)
			cancel()
			if err != nil {
				t.Fatal(err)
			}
			observed := j.observed(t, "session.delegation.created")
			if observed.Event.Item != id {
				t.Fatal("new original provider delegation was refused")
			}
		}
		receipt := []string{"clarify_receipt", "fresh_receipt"}[index]
		content := []string{"Please restate what you would like me to do.", "Thanks for clarifying your request."}[index]
		input := map[string]any{"version": 2, "delegationID": id, "receiptID": receipt, "kind": "delegation.result", "content": content, "ttl": 1000, "created": time.Now().UTC().Format(time.RFC3339Nano)}
		status, body := j.request(http.MethodPost, "/v1/sessions/media_result/result", input, routeToken)
		if status != http.StatusAccepted || len(body) != 6 || body["version"] != float64(2) || body["sessionID"] != "media_result" || body["delegationID"] != id || body["receiptID"] != receipt || body["accepted"] != true || body["played"] != false {
			t.Fatal("clarification/fresh result ACK lost exact original identity", status, body)
		}
		select {
		case command := <-j.commands:
			if command["type"] != "session.commentary.append" || command["delegation_id"] != id || command["content"] != content || command["event_id"] == receipt {
				t.Fatal("clarification/fresh result reached wrong provider identity", command)
			}
		case <-time.After(time.Second):
			t.Fatal("result route fabricated provider acceptance")
		}
		accepted := j.observed(t, "context.injected")
		if accepted.Event.Item != receipt {
			t.Fatal("exact acceptance callback lost private receipt")
		}
		status, _ = j.request(http.MethodPost, "/v1/sessions/media_result/result", input, routeToken)
		if status != http.StatusAccepted {
			t.Fatal("exact clarification retry failed")
		}
		select {
		case j.input <- engine.Frame{Rate: 24000, PCM: make([]byte, 960)}:
		case <-time.After(150 * time.Millisecond):
			t.Fatal("clarification blocked continuous media input")
		}
		select {
		case input := <-j.inputs:
			if input["type"] != "session.input_audio.append" || input["audio"] != strings.Repeat("A", 1280) {
				t.Fatal("continuous silent PCM changed")
			}
		case <-time.After(150 * time.Millisecond):
			t.Fatal("clarification/fresh result stopped actual provider input")
		}
	}
	if j.dials.Load() != 1 {
		t.Fatal("clarification restarted or redialed provider", j.dials.Load())
	}
	status, body := j.request(http.MethodDelete, "/v1/sessions/media_result", nil, routeToken)
	if status != http.StatusOK || body["closed"] != true {
		t.Fatal("explicit Stop did not close actual voice session", status, body)
	}
	status, body = j.request(http.MethodPost, "/v1/sessions/media_result/result", map[string]any{"version": 2, "delegationID": "fresh_result", "receiptID": "after_stop", "kind": "delegation.result", "content": "Do not send this", "ttl": 1000, "created": time.Now().UTC().Format(time.RFC3339Nano)}, routeToken)
	if status != http.StatusConflict || body["accepted"] == true {
		t.Fatal("Stop allowed late result acceptance", status, body)
	}
	select {
	case command := <-j.commands:
		t.Fatal("duplicate/stopped result sent another provider command", command)
	case <-time.After(25 * time.Millisecond):
	}
}
