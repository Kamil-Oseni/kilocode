package app

import (
	"context"
	"errors"
	"math"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/wire"
)

type setup struct {
	id      string
	backend HTTPBackend
}

type prepared interface {
	Startup() (engine.Startup, error)
	Usage() (engine.Usage, error)
}

func (s setup) settle(source prepared) error {
	event, err := settlement(source, 1)
	if event.Type == "" {
		return err
	}
	return errors.Join(err, s.report(wire.Envelope{Session: s.id, Seq: 1, Event: event}))
}

func settlement(source prepared, seq uint64) (engine.Event, error) {
	started, err := source.Startup()
	if err != nil || !validStartup(started) {
		return engine.Event{}, errors.New("provider startup identity is unconfirmed")
	}
	data := map[string]any{"version": 1, "started": map[string]any{"event_id": started.EventID, "model": started.Model}}
	final, observed := source.Usage()
	if observed == nil && validUsage(final) && final.Session == started.Session {
		data["final"] = map[string]any{"event_id": final.EventID, "model": final.Model, "reason": final.Reason, "usage": map[string]any{"seconds": final.Seconds}}
	} else {
		observed = errors.New("final provider setup usage is unconfirmed")
	}
	return engine.Event{Seq: seq, Type: "session.setup.closed", Session: started.Session, At: time.Now().UTC(), Data: data}, observed
}

func (s setup) report(event wire.Envelope) error {
	if s.backend.URL == "" {
		return errors.New("provider setup settlement destination is missing")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	backend := s.backend
	backend.Strict = true
	return backend.Event(ctx, event)
}

func validStartup(started engine.Startup) bool {
	return validUsage(engine.Usage{Session: started.Session, EventID: started.EventID, Model: started.Model, At: started.At, Reason: "close_requested"})
}

func (s setup) failed(voice engine.Session, err error) error {
	if voice != nil {
		closed := voice.Close()
		source, ok := voice.(prepared)
		if !ok {
			return errors.Join(closed, errors.New("provider setup receipts are unavailable"))
		}
		return errors.Join(closed, s.settle(source))
	}
	var failure *engine.OpenError
	if !errors.As(err, &failure) {
		return errors.New("provider open effects are unconfirmed")
	}
	if !failure.Attempted() && failure.Released() {
		return nil
	}
	released := error(nil)
	if !failure.Released() {
		released = errors.New("provider local setup cleanup is unconfirmed")
	}
	return errors.Join(released, s.settle(failure))
}

func lifetime(ctx context.Context, cfg engine.Config, live bool) (context.Context, context.CancelFunc, error) {
	if !live {
		run, cancel := context.WithCancel(context.WithoutCancel(ctx))
		return run, cancel, nil
	}
	if math.IsNaN(cfg.MaximumSeconds) || math.IsInf(cfg.MaximumSeconds, 0) || cfg.MaximumSeconds <= 1.4 || cfg.MaximumSeconds > 86400 {
		return nil, nil, errors.New("Live setup requires a bounded reserved duration")
	}
	run, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Duration((cfg.MaximumSeconds-1.3)*float64(time.Second)))
	return run, cancel, nil
}

func active(voice engine.Session) bool {
	source, ok := voice.(engine.Preparation)
	return ok && source.Active()
}
