// raya_change - Qwen capability honesty and protocol conformance.
package qwen

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/media"
	"github.com/coder/websocket"
)

func TestInterruptedResponseCannotRefillClockWithNewItem(t *testing.T) {
	commands := make(chan string, 4)
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
			var command struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(raw, &command) != nil {
				return
			}
			if command.Type == "session.update" {
				_ = conn.Write(request.Context(), websocket.MessageText, []byte(`{"type":"session.updated"}`))
				continue
			}
			commands <- command.Type
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	voice, err := (Engine{}).Open(ctx, engine.Config{Endpoint: strings.Replace(server.URL, "http://", "ws://", 1), Key: "test"})
	if err != nil {
		t.Fatal(err)
	}
	defer voice.Close()
	session := voice.(*Session)
	created := message{Type: "response.created"}
	created.Response.ID = "first"
	session.handle(created)
	pcm := make([]byte, 480*2*5)
	for index := range pcm {
		pcm[index] = 7
	}
	session.handle(message{Type: "response.audio.delta", ResponseID: "first", ItemID: "old", Delta: base64.StdEncoding.EncodeToString(pcm)})
	if err := session.Interrupt(ctx, "test", 0); err != nil {
		t.Fatal(err)
	}
	select {
	case command := <-commands:
		if command != "response.cancel" {
			t.Fatalf("command = %q", command)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	prior := session.Stats().OutputBytes
	session.handle(message{Type: "response.audio.delta", ResponseID: "first", ItemID: "late-new-item", Delta: base64.StdEncoding.EncodeToString(pcm)})
	if session.Stats().OutputBytes != prior {
		t.Fatal("cancelled response admitted a new item")
	}
	select {
	case frame := <-voice.Audio():
		if frame.Item != "" || frame.Epoch < 2 {
			t.Fatalf("cancelled PCM survived: %#v", frame)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	created.Response.ID = "second"
	completed := message{Type: "response.done"}
	completed.Response.ID = "unrelated"
	completed.Response.Status = "cancelled"
	session.handle(completed)
	if session.pending != "first" {
		t.Fatal("unrelated acknowledgement released cancellation fence")
	}
	completed.Response.ID = "first"
	completed.Response.Status = "cancelled"
	session.handle(completed)
	if session.pending != "" {
		t.Fatal("exact cancellation acknowledgement did not release fence")
	}
	session.handle(created)
	session.handle(message{Type: "response.audio.delta", ResponseID: "second", ItemID: "fresh", Delta: base64.StdEncoding.EncodeToString(pcm[:960])})
	for {
		select {
		case frame := <-voice.Audio():
			if frame.Item == "" {
				continue
			}
			if frame.Item != "fresh" || frame.Epoch < 2 || frame.Start != 0 || frame.End != 480 {
				t.Fatalf("fresh PCM = %#v", frame)
			}
			completed.Response.ID = "second"
			completed.Response.Status = "completed"
			session.handle(completed)
			if err := session.Interrupt(ctx, "completed playback", 0); err != nil {
				t.Fatal(err)
			}
			select {
			case command := <-commands:
				t.Fatalf("completed playback issued another provider action: %s", command)
			case <-time.After(20 * time.Millisecond):
			}
			return
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}

func TestCompletedResponseNeverAdmitsLateAudio(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	session := &Session{ctx: ctx, cancel: cancel, clock: media.NewClock(24000), events: make(chan engine.Event, 8)}
	created := message{Type: "response.created"}
	created.Response.ID = "response"
	session.handle(created)
	completed := message{Type: "response.done"}
	completed.Response.ID = "response"
	completed.Response.Status = "completed"
	session.handle(completed)
	session.handle(message{Type: "response.audio.delta", ResponseID: "response", ItemID: "late", Delta: base64.StdEncoding.EncodeToString(make([]byte, 960))})
	if session.Stats().OutputBytes != 0 || session.Stats().QueuedBytes != 0 {
		t.Fatal("completed response admitted late audio")
	}
}

func TestNewResponseWhileCancellationUnknownFailsClosed(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	session := &Session{ctx: ctx, cancel: cancel, clock: media.NewClock(24000), events: make(chan engine.Event, 8), pending: "first"}
	created := message{Type: "response.created"}
	created.Response.ID = "second"
	session.handle(created)
	if ctx.Err() == nil || session.active != "" || session.pending != "first" {
		t.Fatal("new response escaped unresolved cancellation")
	}
}

func TestOversizedVendorAudioFailsInsteadOfQuietLoss(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	session := &Session{ctx: ctx, cancel: cancel, clock: media.NewClock(24000), events: make(chan engine.Event, 8)}
	created := message{Type: "response.created"}
	created.Response.ID = "response"
	session.handle(created)
	pcm := make([]byte, 960*6)
	session.handle(message{Type: "response.audio.delta", ResponseID: "response", ItemID: "item", Delta: base64.StdEncoding.EncodeToString(pcm)})
	if ctx.Err() == nil || session.Stats().DroppedBytes != uint64(len(pcm)) {
		t.Fatal("oversized vendor burst was silently accepted")
	}
	for range 3 {
		event := <-session.Events()
		if event.Type == "engine.error" {
			return
		}
	}
	t.Fatal("bounded ingress failure was not surfaced")
}

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
