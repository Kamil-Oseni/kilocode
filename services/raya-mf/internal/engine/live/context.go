// raya_change - Exact, non-replaying GPT-Live context append observations.
package live

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
)

var errAppend = errors.New("GPT-Live context acceptance is unconfirmed; do not replay")

type command struct {
	item     engine.ContextItem
	wire     string
	kind     string
	done     chan struct{}
	timer    *time.Timer
	finished bool
	err      error
}

func (s *session) Inject(ctx context.Context, item engine.ContextItem) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.closed.Load() || s.parent.Err() != nil || !s.started.Load() {
		return errors.New("GPT-Live context input is fenced")
	}
	// 500 UTF-8 bytes is a deliberately conservative application ceiling,
	// not a measurement of the documented 500-token provider limit.
	if !identifier(item.ID) || !identifier(strings.ReplaceAll(item.Kind, ".", "_")) || (item.Call != "" && !identifier(item.Call)) || (item.Supersedes != "" && !identifier(item.Supersedes)) || !utf8.ValidString(item.Text) || len(item.Text) == 0 || len(item.Text) > 500 || item.TTLMS < 0 || item.TTLMS > 24*60*60*1000 {
		return errors.New("invalid or oversized GPT-Live context")
	}
	s.mu.Lock()
	prior := s.commands[item.ID]
	if item.Created.IsZero() {
		item.Created = time.Now()
		if prior != nil {
			item.Created = prior.item.Created
		}
	}
	item.Created = item.Created.UTC()
	if prior != nil {
		match := same(prior.item, item)
		s.mu.Unlock()
		if !match {
			return errors.New("GPT-Live context identity was reused")
		}
		return s.await(ctx, prior)
	}
	if len(s.commands) >= 256 {
		s.mu.Unlock()
		return errors.New("GPT-Live context identity allowance exhausted")
	}
	id, err := random()
	if err != nil {
		s.mu.Unlock()
		return err
	}
	kind := "session.thinking.append"
	if item.Kind == "instructions" {
		kind = "session.instructions.append"
	}
	if item.Kind == "commentary" || item.Kind == "delegation.result" {
		kind = "session.commentary.append"
	}
	entry := &command{item: item, wire: "context_" + id, kind: kind, done: make(chan struct{})}
	s.commands[item.ID] = entry
	s.order = append(s.order, item.ID)
	end := time.Now().Add(startup)
	if item.TTLMS > 0 && item.Created.Add(time.Duration(item.TTLMS)*time.Millisecond).Before(end) {
		end = item.Created.Add(time.Duration(item.TTLMS) * time.Millisecond)
	}
	if !end.After(time.Now()) {
		entry.err = errors.New("GPT-Live context expired before sending")
		entry.finished = true
		close(entry.done)
		s.mu.Unlock()
		s.emit(engine.Event{Type: "context.expired", Item: item.ID})
		return entry.err
	}
	entry.timer = time.AfterFunc(time.Until(end), func() { s.complete(entry, errAppend) })
	s.mu.Unlock()
	// Generic ContextItem.Call is not a provider Live delegation ID. Keep
	// private receipt identity in the local record, not speakable content.
	send, cancel := context.WithDeadline(ctx, end)
	defer cancel()
	if err := s.send(send, map[string]any{"type": kind, "event_id": entry.wire, "delegation_id": nil, "content": item.Text}, func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return !entry.finished && time.Now().Before(end)
	}); err != nil {
		s.complete(entry, errors.Join(errAppend, err))
	}
	return s.await(ctx, entry)
}

func (s *session) await(ctx context.Context, entry *command) error {
	select {
	case <-entry.done:
		s.mu.Lock()
		err := entry.err
		s.mu.Unlock()
		return err
	case <-ctx.Done():
		s.complete(entry, errors.Join(errAppend, ctx.Err()))
		return errors.Join(errAppend, ctx.Err())
	}
}

func (s *session) complete(entry *command, err error) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if entry.finished {
		return false
	}
	entry.finished = true
	entry.err = err
	if entry.timer != nil {
		entry.timer.Stop()
	}
	close(entry.done)
	return true
}

func (s *session) ack(msg message) bool {
	id := msg.ClientID
	if msg.Type == "error" && msg.Error.ClientID != "" {
		id = msg.Error.ClientID
	}
	if id == "" {
		return false
	}
	s.mu.Lock()
	var entry *command
	for _, candidate := range s.commands {
		if candidate.wire == id {
			entry = candidate
			break
		}
	}
	s.mu.Unlock()
	if entry == nil {
		return false
	}
	if msg.Type == "error" {
		s.complete(entry, errors.New("OpenAI refused the exact GPT-Live context command"))
		return true
	}
	if msg.Type != strings.TrimSuffix(entry.kind, ".append")+".appended" || !identifier(msg.EventID) || !timeline(msg.Start, msg.End) {
		return false
	}
	if s.complete(entry, nil) {
		s.emit(engine.Event{Type: "context.injected", Item: entry.item.ID, Data: map[string]any{"event_id": msg.EventID, "client_event_id": id, "start_ms": *msg.Start, "end_ms": *msg.End, "accepted": true, "speechPlayed": false}})
	}
	return true
}

func (s *session) settle() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, entry := range s.commands {
		if entry.finished {
			continue
		}
		entry.finished = true
		entry.err = errAppend
		if entry.timer != nil {
			entry.timer.Stop()
		}
		close(entry.done)
	}
}

// Snapshot is local accepted context only, not a provider checkpoint, final
// conversation, or a claim that this content was spoken or heard.
func (s *session) Snapshot(context.Context) (engine.Snapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := make([]engine.ContextItem, 0, len(s.commands))
	for _, id := range s.order {
		entry := s.commands[id]
		if entry.finished && entry.err == nil {
			items = append(items, entry.item)
		}
	}
	return engine.Snapshot{Items: items}, nil
}

func (s *session) Prefill(ctx context.Context, snapshot engine.Snapshot) error {
	if len(snapshot.Items) > 256 {
		return errors.New("GPT-Live snapshot exceeds local context allowance")
	}
	for _, item := range snapshot.Items {
		if item.Kind == "delegation.result" || item.Call != "" {
			return errors.New("GPT-Live result context cannot be replayed through generic prefill")
		}
	}
	for _, item := range snapshot.Items {
		if err := s.Inject(ctx, item); err != nil {
			return err
		}
	}
	return nil
}

func same(a, b engine.ContextItem) bool {
	return a.ID == b.ID && a.Kind == b.Kind && a.Text == b.Text && a.Call == b.Call && a.TTLMS == b.TTLMS && a.Created.Equal(b.Created) && a.Supersedes == b.Supersedes
}
