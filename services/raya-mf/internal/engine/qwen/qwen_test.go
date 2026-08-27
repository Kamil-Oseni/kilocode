// raya_change - Qwen capability honesty and protocol conformance.
package qwen

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/coder/websocket"
)

func TestDescriptorDeclaresTruncationGap(t *testing.T) {
	got := (Engine{}).Descriptor()
	if got.ID != "qwen-realtime" {
		t.Fatalf("id = %q", got.ID)
	}
	if got.AcceptsTruncation {
		t.Fatal("Qwen does not expose measured-playout conversation truncation")
	}
	if !got.NativeBargeIn || !got.NativeEndpointing || !got.RequiresContinuousInput {
		t.Fatalf("unexpected capabilities: %#v", got)
	}
}

func TestSessionUpdateUsesSmartTurnAndDelegateOnly(t *testing.T) {
	got := sessionUpdate(engine.Config{
		Voice:        "longanqian",
		Mode:         "hands-free",
		Threshold:    0.2,
		Silence:      800 * time.Millisecond,
		Instructions: "Be concise.",
	})
	session := got["session"].(map[string]any)
	turn := session["turn_detection"].(map[string]any)
	if turn["type"] != "smart_turn" {
		t.Fatalf("turn detection = %#v", turn)
	}
	tools := session["tools"].([]map[string]any)
	if len(tools) != 1 {
		t.Fatalf("tools = %#v", tools)
	}
	function := tools[0]["function"].(map[string]any)
	if function["name"] != "delegate" {
		t.Fatalf("tools = %#v", tools)
	}
	if session["input_audio_format"] != "pcm" || session["output_audio_format"] != "pcm" {
		t.Fatalf("audio formats = %q/%q", session["input_audio_format"], session["output_audio_format"])
	}
	transcription := session["input_audio_transcription"].(map[string]any)
	if transcription["model"] != "fun-asr" {
		t.Fatalf("input transcription = %#v", transcription)
	}
}

func TestExpiredInjectionNeverReachesVendorSocket(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	session := &Session{ctx: ctx, cancel: cancel, events: make(chan engine.Event, 1)}
	err := session.Inject(ctx, engine.ContextItem{
		ID:      "expired",
		Kind:    "guidance",
		Text:    "stale",
		Created: time.Now().Add(-2 * time.Second),
		TTLMS:   time.Second.Milliseconds(),
	})
	if err != nil {
		t.Fatal(err)
	}
	event := <-session.Events()
	if event.Type != "context.expired" || event.Item != "expired" {
		t.Fatalf("event = %#v", event)
	}
}

func TestOpenWaitsForAcceptedSessionConfiguration(t *testing.T) {
	received := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		conn, err := websocket.Accept(writer, request, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		if _, _, err := conn.Read(request.Context()); err != nil {
			return
		}
		close(received)
		<-release
		_ = conn.Write(request.Context(), websocket.MessageText, []byte(`{"type":"session.updated","session":{"id":"ready"}}`))
		<-request.Context().Done()
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	type result struct {
		session engine.Session
		err     error
	}
	done := make(chan result, 1)
	go func() {
		session, err := (Engine{}).Open(ctx, engine.Config{
			Endpoint: strings.Replace(server.URL, "http://", "ws://", 1),
			Key:      "test",
			Model:    "test",
		})
		done <- result{session: session, err: err}
	}()

	<-received
	select {
	case got := <-done:
		t.Fatalf("open returned before session.updated: %v", got.err)
	case <-time.After(25 * time.Millisecond):
	}
	close(release)
	got := <-done
	if got.err != nil {
		t.Fatal(got.err)
	}
	if err := got.session.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestDelegationInjectionReachesVendorSocketBeforeExpiry(t *testing.T) {
	messages := make(chan map[string]any, 4)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		conn, err := websocket.Accept(writer, request, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		for {
			_, raw, err := conn.Read(request.Context())
			if err != nil {
				return
			}
			var message map[string]any
			if json.Unmarshal(raw, &message) != nil {
				continue
			}
			if message["type"] == "session.update" {
				_ = conn.Write(request.Context(), websocket.MessageText, []byte(`{"type":"session.updated","session":{"id":"ready"}}`))
				continue
			}
			messages <- message
		}
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	session, err := (Engine{}).Open(ctx, engine.Config{
		Endpoint: strings.Replace(server.URL, "http://", "ws://", 1),
		Key:      "test",
		Model:    "test",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	err = session.Inject(ctx, engine.ContextItem{
		ID:      "result",
		Kind:    "delegation.result",
		Text:    "grounded",
		Call:    "call-1",
		TTLMS:   5000,
		Created: time.Now(),
	})
	if err != nil {
		t.Fatal(err)
	}
	item := <-messages
	if item["type"] != "conversation.item.create" {
		t.Fatalf("first injection message = %#v", item)
	}
	payload := item["item"].(map[string]any)
	if payload["type"] != "function_call_output" || payload["call_id"] != "call-1" || payload["output"] != "grounded" {
		t.Fatalf("function output = %#v", payload)
	}
	response := <-messages
	if response["type"] != "response.create" {
		t.Fatalf("second injection message = %#v", response)
	}
}
