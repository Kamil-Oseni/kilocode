// raya_change - Actual loopback GPT-Live WebSockets; no provider or microphone.
package live

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/coder/websocket"
)

type fixture struct {
	delegation string
	server     *httptest.Server
	conn       chan *websocket.Conn
	writes     chan map[string]any
	modify     func(map[string]any, map[string]any) map[string]any
}

func serve(t *testing.T, modify func(map[string]any, map[string]any) map[string]any) *fixture {
	t.Helper()
	f := &fixture{conn: make(chan *websocket.Conn, 1), writes: make(chan map[string]any, 32), modify: modify}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/live/sessions" || r.URL.RawQuery != "" || r.Header.Get("Authorization") != "Bearer loopback-key" {
			t.Error("primary path/query/trusted authorization was changed")
			http.Error(w, "invalid", http.StatusBadRequest)
			return
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.CloseNow()
		f.conn <- conn
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
			select {
			case f.writes <- value:
			default:
				t.Error("loopback observer capacity exceeded")
				return
			}
			var answer map[string]any
			switch value["type"] {
			case "session.start":
				config = value["session"].(map[string]any)
				config["id"] = "live_fixture"
				answer = map[string]any{"type": "session.started", "event_id": "started_fixture", "client_event_id": value["event_id"], "session": config}
			case "session.close":
				answer = map[string]any{"type": "session.closed", "event_id": "closed_fixture", "client_event_id": value["event_id"], "session": config, "reason": "close_requested", "usage": map[string]any{"seconds": 0.02}}
			case "session.instructions.append", "session.thinking.append", "session.commentary.append":
				answer = map[string]any{"type": strings.TrimSuffix(value["type"].(string), ".append") + ".appended", "event_id": "accepted_" + value["event_id"].(string), "client_event_id": value["event_id"], "start_ms": 0, "end_ms": 20}
			}
			if f.modify != nil {
				answer = f.modify(value, answer)
			}
			if answer != nil {
				if err := send(conn, answer); err != nil {
					return
				}
			}
		}
	}))
	t.Cleanup(func() {
		select {
		case conn := <-f.conn:
			_ = conn.CloseNow()
		default:
		}
		f.server.Close()
	})
	return f
}

func send(conn *websocket.Conn, value map[string]any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	return conn.Write(ctx, websocket.MessageText, raw)
}
func (f *fixture) config() engine.Config {
	maximum := float64(0)
	if f.delegation == "client" {
		maximum = 60
	}
	return engine.Config{Endpoint: "ws" + strings.TrimPrefix(f.server.URL, "http") + "/v1/live/sessions", Key: "loopback-key", Delegation: f.delegation, MaximumSeconds: maximum}
}
func opened(t *testing.T, f *fixture) (engine.Session, *websocket.Conn) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	value, err := (Engine{}).Open(ctx, f.config())
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	conn := <-f.conn
	t.Cleanup(func() {
		if err := value.Close(); err != nil {
			t.Error(err)
		}
		cancel()
		_ = conn.CloseNow()
	})
	return value, conn
}
func written(t *testing.T, f *fixture, kind string) map[string]any {
	t.Helper()
	end := time.After(time.Second)
	for {
		select {
		case value := <-f.writes:
			if value["type"] == kind {
				return value
			}
		case <-end:
			t.Fatalf("missing actual wire command %s", kind)
			return nil
		}
	}
}
func observed(t *testing.T, value engine.Session, kind string) engine.Event {
	t.Helper()
	end := time.After(time.Second)
	for {
		select {
		case event, open := <-value.Events():
			if !open {
				t.Fatal("engine events closed before observation")
				return engine.Event{}
			}
			if event.Type == kind {
				return event
			}
		case <-end:
			t.Fatalf("missing actual engine event %s", kind)
			return engine.Event{}
		}
	}
}

func TestLivePrimaryStartupContinuousPCMAndLocalSourceOnly(t *testing.T) {
	f := serve(t, nil)
	value, conn := opened(t, f)
	start := written(t, f, "session.start")
	cfg := start["session"].(map[string]any)
	if cfg["model"] != "gpt-live-1" || cfg["store"] != false || cfg["delegation"] != nil || !identifier(start["event_id"].(string)) {
		t.Fatal("Live primary startup configuration was not exact")
	}
	desc := (Engine{}).Descriptor()
	if desc.ID != "openai-live" || desc.InputRate != 24000 || desc.OutputRate != 24000 || !desc.RequiresContinuousInput || !desc.NativeBargeIn || !desc.NativeEndpointing || desc.AcceptsTruncation {
		t.Fatal("Live descriptor fabricated an unsupported capability")
	}
	for _, pcm := range [][]byte{make([]byte, 960), bytes.Repeat([]byte{1, 2}, 480)} {
		if err := value.PushAudio(context.Background(), pcm); err != nil {
			t.Fatal(err)
		}
		wire := written(t, f, "session.input_audio.append")
		decoded, err := base64.StdEncoding.DecodeString(wire["audio"].(string))
		if err != nil || !bytes.Equal(decoded, pcm) {
			t.Fatal("continuous silence/speech PCM changed at the primary wire")
		}
	}
	if value.PushAudio(context.Background(), make([]byte, 959)) == nil || value.Commit(context.Background()) == nil || value.Interrupt(context.Background(), "barge", time.Millisecond) == nil {
		t.Fatal("Live accepted invalid PCM/manual Realtime controls")
	}
	for _, pcm := range [][]byte{{0x11}, {0x22, 0x33, 0x44}} {
		if err := send(conn, map[string]any{"type": "session.output_audio.delta", "delta": base64.StdEncoding.EncodeToString(pcm)}); err != nil {
			t.Fatal(err)
		}
	}
	end := time.After(time.Second)
	for {
		select {
		case frame := <-value.Audio():
			if frame.Item == "" {
				continue
			}
			if !strings.HasPrefix(frame.Item, "local_") || frame.Turn != "" || frame.Final || frame.Rate != 24000 || frame.Start != 0 || frame.End != 2 || !bytes.Equal(frame.PCM[:4], []byte{0x11, 0x22, 0x33, 0x44}) {
				t.Fatal("continuous PCM fabricated a provider turn/final or lost a partial sample")
			}
			return
		case <-end:
			t.Fatal("actual media clock did not emit provider PCM")
		}
	}
}

func TestLivePreservesTranscriptAndDelegationMetadataWithoutVoiceTurns(t *testing.T) {
	f := serve(t, nil)
	f.delegation = "client"
	value, conn := opened(t, f)
	if err := send(conn, map[string]any{"type": "session.input_transcript.delta", "event_id": "caption_1", "client_event_id": "context_original", "delta": "hello", "start_ms": 1, "end_ms": 20}); err != nil {
		t.Fatal(err)
	}
	caption := observed(t, value, "transcript.input.delta")
	if caption.Session != "live_fixture" || caption.Item != "caption_1" || caption.Text != "hello" || caption.Stable || caption.Turn != "" || caption.Data["event_id"] != "caption_1" || caption.Data["start_ms"] != float64(1) || caption.Data["end_ms"] != float64(20) {
		t.Fatal("raw transcript provenance was changed or declared complete")
	}
	if caption.Data["client_event_id"] != "context_original" || caption.Data["type"] != "session.input_transcript.delta" || caption.Data["delta"] != "hello" {
		t.Fatal("injected transcript correlation was lost")
	}
	if err := send(conn, map[string]any{"type": "session.delegation.created", "event_id": "delegate_1", "offset_ms": 25, "delegation": map[string]any{"id": "del_1", "type": "delegation", "target": "client"}}); err != nil {
		t.Fatal(err)
	}
	delegation := observed(t, value, "session.delegation.created")
	if delegation.Session != "live_fixture" || delegation.Item != "del_1" || delegation.Turn != "" || delegation.Data["offset_ms"] != float64(25) || delegation.Data["delegation"].(map[string]any)["target"] != "client" {
		t.Fatal("delegation metadata lost its exact identity/timeline")
	}
	if err := send(conn, map[string]any{"type": "response.event", "event_id": "backend_1", "event": map[string]any{"type": "response.done"}}); err != nil {
		t.Fatal(err)
	}
	if event := observed(t, value, "live.event"); event.Turn != "" || event.Data["type"] != "response.event" {
		t.Fatal("backend response lifecycle became a voice boundary")
	}
}

func TestLiveStartupRefusesWrongConfigAndUntrustedEndpoints(t *testing.T) {
	for _, change := range []func(map[string]any){
		func(v map[string]any) { v["client_event_id"] = "other_start" },
		func(v map[string]any) { v["session"].(map[string]any)["model"] = "gpt-realtime" },
		func(v map[string]any) {
			v["session"].(map[string]any)["audio"].(map[string]any)["format"].(map[string]any)["rate"] = 16000
		},
		func(v map[string]any) {
			v["session"].(map[string]any)["delegation"] = map[string]any{"type": "responses"}
		},
		func(v map[string]any) { v["session"].(map[string]any)["store"] = true },
		func(v map[string]any) { delete(v, "event_id") },
	} {
		f := serve(t, func(value, answer map[string]any) map[string]any {
			if value["type"] == "session.start" {
				change(answer)
			}
			return answer
		})
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		value, err := (Engine{}).Open(ctx, f.config())
		cancel()
		if value != nil || err == nil {
			t.Fatal("invalid resolved Live config admitted media")
		}
	}
	for _, raw := range []string{"wss://api.openai.com/v1/live/sessions?model=gpt-live-1", "wss://api.openai.com/v1/realtime", "ws://example.com/v1/live/sessions", "wss://user@api.openai.com/v1/live/sessions"} {
		if value, err := (Engine{}).Open(context.Background(), engine.Config{Endpoint: raw, Key: "loopback-key"}); value != nil || err == nil {
			t.Fatal("untrusted/non-Live endpoint was admitted")
		}
	}
}

func TestLiveLogicalCancellationKeepsFinalizationReaderAndFencesMedia(t *testing.T) {
	f := serve(t, func(value, answer map[string]any) map[string]any {
		if value["type"] == "session.close" {
			return nil
		}
		return answer
	})
	ctx, cancel := context.WithCancel(context.Background())
	value, err := (Engine{}).Open(ctx, f.config())
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	conn := <-f.conn
	defer conn.CloseNow()
	cancel()
	close := written(t, f, "session.close")
	if value.PushAudio(context.Background(), make([]byte, 960)) == nil {
		t.Fatal("parent cancellation left microphone input active")
	}
	end := time.After(300 * time.Millisecond)
	for {
		select {
		case _, open := <-value.Audio():
			if !open {
				goto stopped
			}
		case <-end:
			t.Fatal("parent cancellation did not immediately stop media")
		}
	}
stopped:
	if err := send(conn, map[string]any{"type": "session.closed", "event_id": "closed_after_cancel", "client_event_id": close["event_id"], "session": map[string]any{"id": "live_fixture", "model": "gpt-live-1"}, "reason": "close_requested", "usage": map[string]any{"seconds": 0.02}}); err != nil {
		t.Fatal(err)
	}
	if err := value.Close(); err != nil {
		t.Fatal("logical cancellation destroyed the owned finalization reader", err)
	}
	receipt, err := value.(engine.Terminal).Usage()
	if err != nil || receipt.EventID != "closed_after_cancel" || receipt.Session != "live_fixture" || receipt.Seconds != 0.02 || receipt.Reason != "close_requested" || receipt.At.IsZero() {
		t.Fatal("exact terminal usage was lost after cancellation", receipt, err)
	}
}

func TestLiveMissingFinalUsageNeverClaimsCleanClosure(t *testing.T) {
	f := serve(t, func(value, answer map[string]any) map[string]any {
		if value["type"] == "session.close" {
			delete(answer, "usage")
		}
		return answer
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	value, err := (Engine{}).Open(ctx, f.config())
	if err != nil {
		t.Fatal(err)
	}
	conn := <-f.conn
	defer conn.CloseNow()
	if err := value.Close(); !errors.Is(err, errFinal) {
		t.Fatal("missing final usage became successful cleanup")
	}
	if _, err := value.(engine.Terminal).Usage(); err == nil {
		t.Fatal("missing final usage fabricated a receipt")
	}
}

func TestLiveContextExactAcceptanceAndPrivateReceiptIdentity(t *testing.T) {
	f := serve(t, nil)
	value, _ := opened(t, f)
	written(t, f, "session.start")
	item := engine.ContextItem{ID: "receipt_private", Kind: "delegation.result", Call: "call_private", Text: "The reservation is available.", TTLMS: 1000}
	if err := value.Inject(context.Background(), item); err != nil {
		t.Fatal(err)
	}
	wire := written(t, f, "session.commentary.append")
	if wire["event_id"] == item.ID || wire["delegation_id"] != nil || wire["content"] != item.Text || len(wire) != 4 {
		t.Fatal("private receipt became a speakable/provider delegation identity", wire)
	}
	event := observed(t, value, "context.injected")
	if event.Item != item.ID || event.Data["client_event_id"] != wire["event_id"] || event.Data["speechPlayed"] != false {
		t.Fatal("acceptance became playback or lost exact correlation")
	}
	if err := value.Inject(context.Background(), item); err != nil {
		t.Fatal("exact retry lost immutable acceptance", err)
	}
	item.Text = "changed"
	if value.Inject(context.Background(), item) == nil {
		t.Fatal("reused receipt identity admitted changed text")
	}
	snapshot, err := value.Snapshot(context.Background())
	if err != nil || len(snapshot.Items) != 1 || snapshot.Items[0].Text != "The reservation is available." {
		t.Fatal("accepted context snapshot changed")
	}
	if value.Prefill(context.Background(), snapshot) == nil {
		t.Fatal("result replay was admitted")
	}
	select {
	case extra := <-f.writes:
		t.Fatal("exact retry sent another command", extra)
	case <-time.After(30 * time.Millisecond):
	}
}

func TestLiveContextExpiryWhileWriterGateHeldNeverSends(t *testing.T) {
	f := serve(t, nil)
	value, _ := opened(t, f)
	written(t, f, "session.start")
	s := value.(*session)
	<-s.gate
	item := engine.ContextItem{ID: "expires_in_gate", Kind: "fact", Text: "A temporary fact", Created: time.Now(), TTLMS: 25}
	done := make(chan error, 1)
	go func() { done <- value.Inject(context.Background(), item) }()
	select {
	case err := <-done:
		if !errors.Is(err, errAppend) {
			t.Fatal("gate expiry became confirmed acceptance", err)
		}
	case <-time.After(300 * time.Millisecond):
		s.gate <- struct{}{}
		t.Fatal("expiry failed to bound gate wait")
	}
	s.gate <- struct{}{}
	if !errors.Is(value.Inject(context.Background(), item), errAppend) {
		t.Fatal("expired unknown context was replayed")
	}
	select {
	case extra := <-f.writes:
		t.Fatal("expired context reached provider wire", extra)
	case <-time.After(30 * time.Millisecond):
	}
}

func TestLiveContextWrongAckUnknownNoReplayAndByteLimit(t *testing.T) {
	f := serve(t, func(value, answer map[string]any) map[string]any {
		if value["type"] == "session.thinking.append" {
			answer["client_event_id"] = "wrong_context"
		}
		return answer
	})
	value, _ := opened(t, f)
	written(t, f, "session.start")
	item := engine.ContextItem{ID: "unknown_context", Kind: "fact", Text: "A fact"}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	err := value.Inject(ctx, item)
	cancel()
	if !errors.Is(err, errAppend) {
		t.Fatal("wrong ACK established acceptance", err)
	}
	written(t, f, "session.thinking.append")
	if !errors.Is(value.Inject(context.Background(), item), errAppend) {
		t.Fatal("unknown presentation replayed")
	}
	for _, text := range []string{strings.Repeat("a", 501), strings.Repeat("界", 167), string([]byte{0xff})} {
		if value.Inject(context.Background(), engine.ContextItem{ID: "oversized", Kind: "fact", Text: text}) == nil {
			t.Fatal("invalid/oversized UTF-8 context admitted")
		}
	}
	if value.Inject(context.Background(), engine.ContextItem{ID: "expired", Kind: "fact", Text: "old", Created: time.Now().Add(-time.Second), TTLMS: 1}) == nil {
		t.Fatal("expired context admitted")
	}
	select {
	case extra := <-f.writes:
		t.Fatal("unknown/invalid context sent another command", extra)
	case <-time.After(30 * time.Millisecond):
	}
}

func TestLiveCumulativeUsageRemainsObservationUntilTerminal(t *testing.T) {
	f := serve(t, nil)
	value, conn := opened(t, f)
	if _, err := value.(engine.Terminal).Usage(); err == nil {
		t.Fatal("unclosed session fabricated final usage")
	}
	for index, seconds := range []float64{2.5, 4.5} {
		if err := send(conn, map[string]any{"type": "session.usage.updated", "event_id": []string{"usage_1", "usage_2"}[index], "usage": map[string]any{"seconds": seconds}}); err != nil {
			t.Fatal(err)
		}
		event := observed(t, value, "session.usage.updated")
		if event.Data["usage"].(map[string]any)["seconds"] != seconds {
			t.Fatal("cumulative seconds were summed or discarded")
		}
	}
	if _, err := value.(engine.Terminal).Usage(); err == nil {
		t.Fatal("running usage fabricated terminal confirmation")
	}
	if err := value.Close(); err != nil {
		t.Fatal(err)
	}
	receipt, err := value.(engine.Terminal).Usage()
	if err != nil || receipt.EventID != "closed_fixture" || receipt.Seconds != 0.02 {
		t.Fatal("terminal exact usage receipt changed")
	}
	receipt.EventID = "mutated"
	retained, err := value.(engine.Terminal).Usage()
	if err != nil || retained.EventID != "closed_fixture" {
		t.Fatal("terminal receipt was mutable through its accessor")
	}
}

func TestLiveContradictoryDelegationAndMalformedOutputFailClosed(t *testing.T) {
	for _, event := range []map[string]any{
		{"type": "session.delegation.created", "event_id": "delegate_bad", "offset_ms": 1, "delegation": map[string]any{"id": "del_bad", "type": "delegation", "target": "responses"}},
		{"type": "session.output_audio.delta", "delta": "invalid-base64"},
		{"type": "session.output_audio.delta", "delta": base64.StdEncoding.EncodeToString(make([]byte, 4802))},
	} {
		f := serve(t, nil)
		ctx, cancel := context.WithCancel(context.Background())
		value, err := (Engine{}).Open(ctx, f.config())
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		conn := <-f.conn
		if err := send(conn, event); err != nil {
			cancel()
			t.Fatal(err)
		}
		observed(t, value, "engine.error")
		if value.PushAudio(context.Background(), make([]byte, 960)) == nil {
			t.Fatal("failed Live lane still accepted audio")
		}
		if err := value.Close(); !errors.Is(err, errFinal) {
			t.Fatal("failed read lane fabricated finalization", err)
		}
		cancel()
		_ = conn.CloseNow()
	}
}

func TestLiveDelegationResultExactOriginalAndImmutableReceipts(t *testing.T) {
	f := serve(t, nil)
	f.delegation = "client"
	value, conn := opened(t, f)
	start := written(t, f, "session.start")
	if start["session"].(map[string]any)["delegation"].(map[string]any)["type"] != "client" {
		t.Fatal("client delegation was not explicitly configured")
	}
	result := engine.Result{DelegationID: "del_original", ReceiptID: "receipt_original", Kind: "delegation.result", Content: "The task is complete.", TTLMS: 1000}
	delegator := value.(engine.Delegator)
	if delegator.Result(context.Background(), result) == nil {
		t.Fatal("unobserved original delegation admitted")
	}
	if err := send(conn, map[string]any{"type": "session.delegation.created", "event_id": "delegate_original", "offset_ms": 25, "delegation": map[string]any{"id": "del_original", "type": "delegation", "target": "client"}}); err != nil {
		t.Fatal(err)
	}
	observed(t, value, "session.delegation.created")
	if err := delegator.Result(context.Background(), result); err != nil {
		t.Fatal(err)
	}
	wire := written(t, f, "session.commentary.append")
	if wire["delegation_id"] != result.DelegationID || wire["content"] != result.Content || wire["event_id"] == result.ReceiptID || len(wire) != 4 {
		t.Fatal("result lost original provider identity or exposed private receipt", wire)
	}
	observed(t, value, "context.injected")
	if err := delegator.Result(context.Background(), result); err != nil {
		t.Fatal("exact result retry lost accepted receipt", err)
	}
	changed := result
	changed.ReceiptID = "another_receipt"
	changed.Kind = "thinking"
	changed.Content = "A quiet progress update."
	if err := delegator.Result(context.Background(), changed); err != nil {
		t.Fatal("original delegation refused a distinct explicit update", err)
	}
	update := written(t, f, "session.thinking.append")
	if update["delegation_id"] != result.DelegationID || update["content"] != changed.Content {
		t.Fatal("quiet update lost original identity")
	}
	observed(t, value, "context.injected")
	if err := send(conn, map[string]any{"type": "session.delegation.created", "event_id": "delegate_second", "offset_ms": 30, "delegation": map[string]any{"id": "del_second", "type": "delegation", "target": "client"}}); err != nil {
		t.Fatal(err)
	}
	observed(t, value, "session.delegation.created")
	changed = result
	changed.DelegationID = "del_second"
	if delegator.Result(context.Background(), changed) == nil {
		t.Fatal("local receipt identity moved between provider delegations")
	}
	changed = result
	changed.Content = "different"
	if delegator.Result(context.Background(), changed) == nil {
		t.Fatal("same receipt admitted changed content")
	}
	snapshot, err := value.Snapshot(context.Background())
	if err != nil || len(snapshot.Items) != 0 {
		t.Fatal("original delegation results leaked into replayable snapshot")
	}
	select {
	case extra := <-f.writes:
		t.Fatal("retry/changed result sent another append", extra)
	case <-time.After(25 * time.Millisecond):
	}
}

func TestLiveDelegationResultUnknownAckCannotReplayOrChangeReceipt(t *testing.T) {
	f := serve(t, func(value, answer map[string]any) map[string]any {
		if value["type"] == "session.commentary.append" {
			answer["client_event_id"] = "wrong_result"
		}
		return answer
	})
	f.delegation = "client"
	value, conn := opened(t, f)
	written(t, f, "session.start")
	if err := send(conn, map[string]any{"type": "session.delegation.created", "event_id": "delegate_unknown", "offset_ms": 1, "delegation": map[string]any{"id": "del_unknown", "type": "delegation", "target": "client"}}); err != nil {
		t.Fatal(err)
	}
	observed(t, value, "session.delegation.created")
	result := engine.Result{DelegationID: "del_unknown", ReceiptID: "receipt_unknown", Kind: "commentary", Content: "A result", Created: time.Now(), TTLMS: 25}
	if err := value.(engine.Delegator).Result(context.Background(), result); !errors.Is(err, errAppend) {
		t.Fatal("wrong result ACK admitted acceptance", err)
	}
	written(t, f, "session.commentary.append")
	if err := value.(engine.Delegator).Result(context.Background(), result); !errors.Is(err, errAppend) {
		t.Fatal("unknown result replayed", err)
	}
	result.ReceiptID = "replacement_receipt"
	if value.(engine.Delegator).Result(context.Background(), result) == nil {
		t.Fatal("unknown side effect gained replacement identity")
	}
	select {
	case extra := <-f.writes:
		t.Fatal("unknown result sent again", extra)
	case <-time.After(25 * time.Millisecond):
	}
}

func TestLiveReservedLifetimeFencesInputAndClosesBeforeCap(t *testing.T) {
	f := serve(t, nil)
	f.delegation = "client"
	cfg := f.config()
	cfg.MaximumSeconds = 1.6
	began := time.Now()
	value, err := (Engine{}).Open(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	conn := <-f.conn
	defer conn.CloseNow()
	written(t, f, "session.start")
	written(t, f, "session.close")
	if elapsed := time.Since(began); elapsed > 800*time.Millisecond {
		t.Fatal("reserved lifetime did not fence before finalization allowance", elapsed)
	}
	if value.PushAudio(context.Background(), make([]byte, 960)) == nil {
		t.Fatal("budget expiry left paid input active")
	}
	if value.(engine.Preparation).Active() {
		t.Fatal("expired budget retained UI admission authority")
	}
	if err := value.(engine.Delegator).Result(context.Background(), engine.Result{DelegationID: "unknown", ReceiptID: "late", Kind: "thinking", Content: "late"}); err == nil {
		t.Fatal("budget expiry left paid context active")
	}
	if err := value.Close(); err != nil {
		t.Fatal("budget stop lost actual terminal ACK", err)
	}
	if elapsed := time.Since(began); elapsed >= time.Duration(cfg.MaximumSeconds*float64(time.Second)) {
		t.Fatal("provider cleanup exceeded reserved cap", elapsed)
	}
	if _, err := value.(engine.Terminal).Usage(); err != nil {
		t.Fatal("budget expiry fabricated/omitted terminal receipt", err)
	}
}

func TestLiveClientBudgetInvalidRefusesBeforeDial(t *testing.T) {
	f := serve(t, nil)
	f.delegation = "client"
	for _, maximum := range []float64{0, -1, 1.4, 86401, math.Inf(1), math.NaN()} {
		cfg := f.config()
		cfg.MaximumSeconds = maximum
		if value, err := (Engine{}).Open(context.Background(), cfg); value != nil || err == nil {
			t.Fatal("invalid client lifetime admitted provider connection", maximum)
		}
	}
	select {
	case conn := <-f.conn:
		_ = conn.CloseNow()
		t.Fatal("invalid lifetime dialed provider before rejection")
	default:
	}
}

func TestLiveOpenCancellationRetainsLateStartupAndFinalReceipts(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f := serve(t, func(value, answer map[string]any) map[string]any {
		if value["type"] == "session.start" {
			cancel()
			<-time.After(20 * time.Millisecond)
		}
		return answer
	})
	value, err := (Engine{}).Open(ctx, f.config())
	if value != nil || !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled Open admitted a voice owner", err)
	}
	var failure *engine.OpenError
	if !errors.As(err, &failure) || !failure.Attempted() || !failure.Released() {
		t.Fatal("paid setup lost exact local ownership disposition", err)
	}
	start, err := failure.Startup()
	if err != nil || start.Session != "live_fixture" || start.EventID != "started_fixture" || start.Model != "gpt-live-1" || start.At.IsZero() {
		t.Fatal("late exact startup receipt was discarded", start, err)
	}
	usage, err := failure.Usage()
	if err != nil || usage.EventID != "closed_fixture" || usage.Session != start.Session || usage.Seconds != 0.02 {
		t.Fatal("cancelled setup discarded final usage", usage, err)
	}
	start.EventID = "mutated"
	usage.EventID = "mutated"
	retained, _ := failure.Startup()
	final, _ := failure.Usage()
	if retained.EventID != "started_fixture" || final.EventID != "closed_fixture" {
		t.Fatal("error accessor exposed mutable receipt state")
	}
}

func TestLiveOpenDeadlineRetainsExactReceiptsAfterTimeout(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	f := serve(t, func(value, answer map[string]any) map[string]any {
		if value["type"] == "session.start" {
			<-time.After(120 * time.Millisecond)
		}
		return answer
	})
	value, err := (Engine{}).Open(ctx, f.config())
	if value != nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("timed out Open admitted provider", err)
	}
	var failure *engine.OpenError
	if !errors.As(err, &failure) || !failure.Attempted() || !failure.Released() {
		t.Fatal("timeout lost local cleanup disposition", err)
	}
	start, err := failure.Startup()
	if err != nil || start.EventID != "started_fixture" {
		t.Fatal("timeout erased late startup ACK", err)
	}
	usage, err := failure.Usage()
	if err != nil || usage.Session != start.Session || usage.EventID != "closed_fixture" {
		t.Fatal("timeout erased exact terminal ACK", err)
	}
}

func TestLiveOpenUnknownFinalRemainsTypedUnconfirmed(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f := serve(t, func(value, answer map[string]any) map[string]any {
		if value["type"] == "session.start" {
			cancel()
			<-time.After(20 * time.Millisecond)
		}
		if value["type"] == "session.close" {
			return nil
		}
		return answer
	})
	value, err := (Engine{}).Open(ctx, f.config())
	if value != nil || !errors.Is(err, errFinal) {
		t.Fatal("unknown paid finalization became clean Open failure", err)
	}
	var failure *engine.OpenError
	if !errors.As(err, &failure) || !failure.Attempted() || !failure.Released() {
		t.Fatal("typed failure confused local release with final provider ACK", err)
	}
	if start, err := failure.Startup(); err != nil || start.Session != "live_fixture" {
		t.Fatal("unknown finalization lost trusted startup", start, err)
	}
	if _, err := failure.Usage(); err == nil {
		t.Fatal("missing terminal ACK fabricated usage")
	}
}

func TestLivePrevalidationTypedReleaseNeverDials(t *testing.T) {
	f := serve(t, nil)
	f.delegation = "client"
	for _, change := range []func(*engine.Config){
		func(cfg *engine.Config) { cfg.Key = "" },
		func(cfg *engine.Config) { cfg.Model = "gpt-realtime" },
		func(cfg *engine.Config) { cfg.Mode = "unknown" },
		func(cfg *engine.Config) { cfg.Delegation = "responses" },
		func(cfg *engine.Config) { cfg.MaximumSeconds = 0 },
		func(cfg *engine.Config) { cfg.Voice = "invalid voice" },
		func(cfg *engine.Config) { cfg.Instructions = string([]byte{0xff}) },
		func(cfg *engine.Config) { cfg.Endpoint += "?model=gpt-live-1" },
	} {
		cfg := f.config()
		cfg.MaximumSeconds = 10
		change(&cfg)
		value, err := (Engine{}).Open(context.Background(), cfg)
		var failure *engine.OpenError
		if value != nil || !errors.As(err, &failure) || failure.Attempted() || !failure.Released() {
			t.Fatal("prevalidation refusal lost certain no-provider disposition", err)
		}
		if _, err := failure.Startup(); err == nil {
			t.Fatal("prevalidation fabricated startup")
		}
		if _, err := failure.Usage(); err == nil {
			t.Fatal("prevalidation fabricated usage")
		}
	}
	select {
	case conn := <-f.conn:
		_ = conn.CloseNow()
		t.Fatal("prevalidation opened actual loopback provider")
	default:
	}
	select {
	case wire := <-f.writes:
		t.Fatal("prevalidation sent actual provider command", wire)
	default:
	}
}
