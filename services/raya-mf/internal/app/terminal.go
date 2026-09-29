package app

import (
	"context"
	"errors"
	"math"
	"strings"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/wire"
)

func (s *Session) terminal(source engine.Terminal) error {
	if !s.startup.Load() && s.backend != nil {
		owned, ok := source.(prepared)
		if !ok {
			s.statusMu.Lock()
			s.status.BackendReport = "failed"
			s.statusMu.Unlock()
			return errors.New("provider startup receipt is unavailable")
		}
		event, observed := settlement(owned, s.seq.Add(1))
		if event.Type == "" {
			s.statusMu.Lock()
			s.status.BackendReport = "failed"
			s.statusMu.Unlock()
			return observed
		}
		return s.accounting(event, observed)
	}
	usage, err := source.Usage()
	if err != nil || !validUsage(usage) {
		if s.backend != nil {
			s.statusMu.Lock()
			s.status.BackendReport = "failed"
			s.statusMu.Unlock()
		}
		return errors.New("final provider voice usage is unconfirmed")
	}
	if s.backend == nil {
		return nil
	}
	seq := s.seq.Add(1)
	event := engine.Event{Type: "session.closed", Session: usage.Session, Seq: seq, At: usage.At,
		Data: map[string]any{"event_id": usage.EventID, "model": usage.Model, "reason": usage.Reason, "usage": map[string]any{"seconds": usage.Seconds}}}
	return s.accounting(event, nil)
}

func (s *Session) accounting(event engine.Event, observed error) error {
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	err := errors.Join(observed, s.backend.Event(ctx, wire.Envelope{Session: s.id, Seq: event.Seq, Event: event}))
	s.statusMu.Lock()
	s.status.BackendReport = delivery(err)
	s.statusMu.Unlock()
	if err != nil {
		return errors.New("final provider voice usage delivery is unconfirmed")
	}
	return nil
}

func validUsage(usage engine.Usage) bool {
	for _, id := range []string{usage.Session, usage.EventID} {
		if id == "" || len(id) > 256 || strings.TrimSpace(id) != id {
			return false
		}
		for _, value := range id {
			if value < 33 || value > 126 {
				return false
			}
		}
	}
	if usage.Model != "gpt-live-1" || usage.At.IsZero() || math.IsNaN(usage.Seconds) || math.IsInf(usage.Seconds, 0) || usage.Seconds < 0 || usage.Seconds > 24*60*60 {
		return false
	}
	switch usage.Reason {
	case "close_requested", "expired", "content", "remote_hangup", "connection_lost":
		return true
	default:
		return false
	}
}
