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
)

var secret = errors.New("synthetic provider secret must not enter diagnostics")

type failingEngine struct {
	*fakeEngine
	code   string
	closed atomic.Int32
}

func (f *failingEngine) PushAudio(ctx context.Context, pcm []byte) error {
	if f.code == "audio_input" {
		return secret
	}
	return f.fakeEngine.PushAudio(ctx, pcm)
}
func (f *failingEngine) Interrupt(ctx context.Context, reason string, heard time.Duration) error {
	if f.code == "engine_interrupt" {
		return secret
	}
	return f.fakeEngine.Interrupt(ctx, reason, heard)
}
func (f *failingEngine) Inject(context.Context, engine.ContextItem) error { return secret }
func (f *failingEngine) Close() error                                     { f.closed.Add(1); return nil }

type failingRoom struct {
	*fakeRoom
	code    string
	closed  atomic.Int32
	reports atomic.Int32
	item    string
}

func (f *failingRoom) Publish(ctx context.Context, frame engine.Frame) error {
	if f.code == "audio_publish" {
		return secret
	}
	return f.fakeRoom.Publish(ctx, frame)
}
func (f *failingRoom) Send(ctx context.Context, data room.Data) error {
	if strings.Contains(string(data.Body), `"type":"failure"`) {
		f.reports.Add(1)
		if f.code == "both_reports" {
			return secret
		}
	}
	if (f.code == "playout_metadata" && data.Topic == "raya.playout.item") ||
		(f.code == "transcript_send" && data.Topic == "raya.transcript") ||
		(f.code == "interruption_send" && data.Topic == "raya.control" && !strings.Contains(string(data.Body), `"type":"failure"`)) {
		return secret
	}
	return f.fakeRoom.Send(ctx, data)
}
func (f *failingRoom) Flush(ctx context.Context, item string) error {
	f.item = item
	if f.code == "playout_flush" {
		return secret
	}
	return f.fakeRoom.Flush(ctx, item)
}
func (f *failingRoom) Close() error {
	f.closed.Add(1)
	if f.code == "both_reports" {
		return secret
	}
	return nil
}

type failingBackend struct {
	code    string
	calls   atomic.Int32
	events  chan wire.Envelope
	entered chan struct{}
}

func (f *failingBackend) Event(ctx context.Context, event wire.Envelope) error {
	count := f.calls.Add(1)
	if count == 1 && f.entered != nil {
		close(f.entered)
	}
	if f.code == "backend_delivery" || f.code == "both_reports" {
		return secret
	}
	if f.code == "event_queue_overflow" {
		<-ctx.Done()
		return ctx.Err()
	}
	f.events <- event
	return nil
}
func finished(t *testing.T, s *Session) wire.Status {
	t.Helper()
	select {
	case <-s.done:
		return s.Status()
	case <-time.After(3 * time.Second):
		t.Fatal("failed session did not finish cleanup")
		return wire.Status{}
	}
}
func TestCriticalBoundariesStopAndReportSanitizedFailure(t *testing.T) {
	for _, code := range []string{"audio_input", "audio_publish", "playout_metadata", "transcript_send", "playout_flush", "engine_interrupt", "interruption_send", "engine_failure", "engine_inject", "room_input_closed", "room_data_closed", "engine_audio_closed", "engine_events_closed", "backend_delivery"} {
		t.Run(code, func(t *testing.T) {
			voice := &failingEngine{fakeEngine: newFakeEngine(), code: code}
			media := &failingRoom{fakeRoom: newFakeRoom(), code: code}
			backend := &failingBackend{code: code, events: make(chan wire.Envelope, 8)}
			s := NewSession(context.Background(), "failure", voice, media, backend)
			defer s.Close()
			switch code {
			case "audio_input":
				media.input <- engine.Frame{PCM: []byte{0, 0}}
			case "audio_publish":
				voice.audio <- engine.Frame{PCM: []byte{0, 0}}
			case "playout_metadata":
				voice.audio <- engine.Frame{Item: "assistant", PCM: []byte{0, 0}}
			case "transcript_send":
				voice.events <- engine.Event{Type: "transcript.input.done", Text: "synthetic"}
			case "playout_flush", "engine_interrupt", "interruption_send":
				s.heard = wire.Playout{Item: "intended-assistant", Samples: 12000, Rate: 24000}
				s.barge()
				if media.item != "intended-assistant" {
					t.Fatalf("flushed wrong speech: %q", media.item)
				}
			case "engine_failure":
				voice.events <- engine.Event{Type: "engine.error", Text: secret.Error()}
			case "engine_inject":
				if err := s.Inject(context.Background(), engine.ContextItem{}); err == nil {
					t.Fatal("injection succeeded")
				}
			case "room_input_closed":
				close(media.input)
			case "room_data_closed":
				close(media.data)
			case "engine_audio_closed":
				close(voice.audio)
			case "engine_events_closed":
				close(voice.events)
			case "backend_delivery":
				voice.events <- engine.Event{Type: "session.updated"}
			}
			status := finished(t, s)
			if status.State != "failed" || status.Failure == nil || status.Failure.Code != code {
				t.Fatalf("status = %#v", status)
			}
			if status.RoomReport != "succeeded" || status.Cleanup != "succeeded" {
				t.Fatalf("delivery/cleanup = %#v", status)
			}
			if media.closed.Load() != 1 || voice.closed.Load() != 1 || media.reports.Load() != 1 {
				t.Fatal("failure did not release/report once")
			}
			raw, _ := json.Marshal(status)
			if strings.Contains(string(raw), "secret") || !strings.Contains(string(raw), "Reconnect") {
				t.Fatalf("unsafe/non-actionable status: %s", raw)
			}
			if code != "backend_delivery" {
				event := <-backend.events
				if event.Event.Type != "engine.error" {
					t.Fatalf("failure event = %#v", event)
				}
				raw, _ := json.Marshal(event)
				if strings.Contains(string(raw), "secret") {
					t.Fatalf("provider payload leaked: %s", raw)
				}
			} else if backend.calls.Load() != 2 {
				t.Fatalf("backend failure recursively retried: %d", backend.calls.Load())
			}
			s.fail("engine_failure")
			if s.Status().Failure.Code != code {
				t.Fatal("first failure was overwritten")
			}
		})
	}
}
func TestQueueOverflowFailsInsteadOfSilentlyLosingTaskEvents(t *testing.T) {
	voice := &failingEngine{fakeEngine: newFakeEngine()}
	voice.events = make(chan engine.Event, 100)
	media := &failingRoom{fakeRoom: newFakeRoom()}
	backend := &failingBackend{code: "event_queue_overflow", entered: make(chan struct{})}
	s := NewSession(context.Background(), "overflow", voice, media, backend)
	defer s.Close()
	voice.events <- engine.Event{Type: "session.updated"}
	<-backend.entered
	for range 90 {
		voice.events <- engine.Event{Type: "session.updated"}
	}
	status := finished(t, s)
	if status.Failure == nil || status.Failure.Code != "event_queue_overflow" {
		t.Fatalf("status = %#v", status)
	}
	if status.BackendReport != "failed" || status.RoomReport != "succeeded" {
		t.Fatalf("report = %#v", status)
	}
	if backend.calls.Load() != 2 {
		t.Fatalf("unexpected delivery attempts: %d", backend.calls.Load())
	}
}
func TestFailedReportingAndCleanupRemainReadableWithoutRecursion(t *testing.T) {
	voice := &failingEngine{fakeEngine: newFakeEngine()}
	media := &failingRoom{fakeRoom: newFakeRoom(), code: "both_reports"}
	backend := &failingBackend{code: "both_reports"}
	s := NewSession(context.Background(), "retained", voice, media, backend)
	voice.events <- engine.Event{Type: "engine.error", Text: secret.Error()}
	status := finished(t, s)
	if status.RoomReport != "failed" || status.BackendReport != "failed" || status.Cleanup != "failed" {
		t.Fatalf("status = %#v", status)
	}
	if !errors.Is(s.Close(), secret) || !errors.Is(s.Close(), secret) {
		t.Fatal("cleanup error lost")
	}
	if media.reports.Load() != 1 || backend.calls.Load() != 1 || media.closed.Load() != 1 || voice.closed.Load() != 1 {
		t.Fatal("failure recursively reported or cleanup retried")
	}
	status.Failure.Code = "modified"
	if s.Status().Failure.Code != "engine_failure" {
		t.Fatal("caller mutated saved failure")
	}
}

func TestFailureOutcomeRemainsReadableThroughManagerUntilSuccessfulClose(t *testing.T) {
	voice := &failingEngine{fakeEngine: newFakeEngine()}
	media := &failingRoom{fakeRoom: newFakeRoom(), code: "both_reports"}
	manager := NewManager(joining{join: func(context.Context) (room.Room, error) { return media, nil }})
	manager.engine = opening{open: func(context.Context) (engine.Session, error) { return voice, nil }}
	if _, err := manager.Start(context.Background(), wire.Start{ID: "retained"}); err != nil {
		t.Fatal(err)
	}
	manager.mu.RLock()
	session := manager.sessions["retained"].session
	manager.mu.RUnlock()
	voice.events <- engine.Event{Type: "engine.error", Text: secret.Error()}
	finished(t, session)
	for range 2 {
		if !errors.Is(manager.Close("retained"), secret) {
			t.Fatal("close lost cleanup error")
		}
		status, found := manager.Status("retained")
		if !found || status.Failure == nil || status.Cleanup != "failed" || status.BackendReport != "not_configured" {
			t.Fatalf("status = %#v, found %v", status, found)
		}
	}
	healthy := NewManager(joining{join: func(context.Context) (room.Room, error) { return newFakeRoom(), nil }})
	healthy.engine = opening{open: func(context.Context) (engine.Session, error) { return newFakeEngine(), nil }}
	if _, err := healthy.Start(context.Background(), wire.Start{ID: "healthy"}); err != nil {
		t.Fatal(err)
	}
	if err := healthy.Close("healthy"); err != nil {
		t.Fatal(err)
	}
	if _, found := healthy.Status("healthy"); found {
		t.Fatal("successful close retained session")
	}
}
func TestFailureUsesActualHTTPBackendWithoutLeakingProviderPayload(t *testing.T) {
	received := make(chan wire.Envelope, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/kilocode/voice/events" || r.URL.Query().Get("directory") != "synthetic workspace" || r.Header.Get("Authorization") != "synthetic-auth" {
			t.Error("wrong event route or authorization")
		}
		var event wire.Envelope
		if err := json.NewDecoder(r.Body).Decode(&event); err != nil {
			t.Error(err)
		}
		received <- event
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte("true"))
	}))
	defer server.Close()
	voice := &failingEngine{fakeEngine: newFakeEngine()}
	s := NewSession(context.Background(), "http", voice, newFakeRoom(), HTTPBackend{URL: server.URL, Auth: "synthetic-auth", Directory: "synthetic workspace"})
	defer s.Close()
	voice.events <- engine.Event{Type: "engine.error", Text: secret.Error()}
	status := finished(t, s)
	if status.BackendReport != "succeeded" {
		t.Fatalf("status = %#v", status)
	}
	event := <-received
	raw, _ := json.Marshal(event)
	if event.Session != "http" || event.Event.Type != "engine.error" || strings.Contains(string(raw), "secret") {
		t.Fatalf("event = %s", raw)
	}
}
