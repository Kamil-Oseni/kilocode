package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/room"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/wire"
)

var failures = map[string]string{
	"room_data_closed":     "The voice room control connection closed.",
	"room_input_closed":    "Microphone input from the voice room stopped.",
	"engine_audio_closed":  "The voice engine audio connection closed.",
	"engine_events_closed": "The voice engine event connection closed.",
	"audio_input":          "Microphone audio could not reach the voice engine.",
	"audio_publish":        "The voice response could not reach audio playback.",
	"playout_metadata":     "Audio playback could not be associated with its response.",
	"transcript_send":      "The live voice transcript could not be delivered.",
	"playout_flush":        "Voice playback could not be interrupted safely.",
	"engine_interrupt":     "The voice engine did not accept the interruption.",
	"interruption_send":    "The interrupted playback position could not be delivered.",
	"backend_delivery":     "Voice events could not reach the Raya task.",
	"event_queue_overflow": "Voice events exceeded the task delivery buffer.",
	"engine_failure":       "The voice engine reported a failure.",
	"engine_inject":        "Task context could not reach the voice engine.",
}

func (s *Session) Status() wire.Status {
	s.statusMu.RLock()
	defer s.statusMu.RUnlock()
	status := s.status
	if status.Failure != nil {
		failure := *status.Failure
		status.Failure = &failure
	}
	return status
}

func (s *Session) fail(code string) {
	s.statusMu.Lock()
	defer s.statusMu.Unlock()
	if s.ctx.Err() != nil || s.status.Failure != nil {
		return
	}
	s.status.State = "failed"
	s.status.Failure = &wire.Failure{Code: code, Message: failures[code], Recovery: "Reconnect voice with the selected provider, or continue typing. If reconnect fails, restart the media frontend.", At: time.Now().UTC()}
	s.speaking.Store(false)
	s.cancel()
}

// Only this supervisor closes resources. Workers signal failure and return;
// they never wait for their own WaitGroup or recursively report send failures.
func (s *Session) finish() {
	<-s.ctx.Done()
	status := s.Status()
	if status.Failure != nil {
		slog.Error("voice session failed", "session", s.id, "code", status.Failure.Code)
		raw, _ := json.Marshal(map[string]any{"type": "failure", "session": s.id, "failure": status.Failure})
		ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
		sent := s.room.Send(ctx, room.Data{Topic: "raya.control", Body: raw})
		cancel()
		s.statusMu.Lock()
		s.status.RoomReport = delivery(sent)
		if sent != nil {
			slog.Warn("voice failure notification failed", "session", s.id, "transport", "room")
		}
		s.statusMu.Unlock()
		if s.backend != nil {
			seq := s.seq.Add(1)
			event := engine.Event{Seq: seq, Type: "engine.error", At: status.Failure.At, Data: map[string]any{"failure": status.Failure}}
			ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
			sent := s.backend.Event(ctx, wire.Envelope{Session: s.id, Seq: seq, Event: event})
			cancel()
			s.statusMu.Lock()
			s.status.BackendReport = delivery(sent)
			if sent != nil {
				slog.Warn("voice failure notification failed", "session", s.id, "transport", "backend")
			}
			s.statusMu.Unlock()
		}
	}
	s.closed = errors.Join(s.room.Close(), s.engine.Close())
	s.wait.Wait()
	s.statusMu.Lock()
	s.status.Cleanup = delivery(s.closed)
	if s.status.Failure == nil {
		s.status.State = "closed"
	}
	if s.closed != nil {
		s.status.State = "failed"
		slog.Error("voice resource cleanup failed", "session", s.id, "recovery", "restart media frontend")
	}
	s.statusMu.Unlock()
	close(s.done)
}

func delivery(err error) string {
	if err != nil {
		return "failed"
	}
	return "succeeded"
}
