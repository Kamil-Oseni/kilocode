// raya_change - Owned append-only generic context lifecycle, never provider replay.
package live

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
)

func clone(item engine.ContextItem) engine.ContextItem {
	item.Replaces = append([]string(nil), item.Replaces...)
	return item
}

func factual(item engine.ContextItem) bool {
	return item.Call == "" && item.Kind != "delegation.result" && item.Kind != "commentary"
}

func valid(item engine.ContextItem) bool {
	_, err := targets(item)
	return err == nil && identifier(item.ID) && identifier(strings.ReplaceAll(item.Kind, ".", "_")) && (item.Call == "" || identifier(item.Call)) && utf8.ValidString(item.Text) && len(item.Text) > 0 && len(item.Text) <= 500 && item.TTLMS >= 0 && item.TTLMS <= 24*60*60*1000
}

func targets(item engine.ContextItem) ([]string, error) {
	refs := item.Replaces
	if item.Supersedes != "" {
		if len(refs) != 0 {
			return nil, errors.New("mixed context supersession fields")
		}
		refs = []string{item.Supersedes}
	}
	if len(refs) > 8 {
		return nil, errors.New("too many context supersession targets")
	}
	seen := map[string]bool{}
	for _, id := range refs {
		if !identifier(id) || id == item.ID || seen[id] {
			return nil, errors.New("invalid context supersession target")
		}
		seen[id] = true
	}
	return refs, nil
}

func projection(item engine.ContextItem, label string, refs []string, expired string) string {
	if expired != "" {
		return "Context " + label + " (internal reference, never spoken): Prior context " + expired + " has expired; no longer use it as facts or instructions."
	}
	if len(refs) != 0 {
		return "Context " + label + " (internal reference, never spoken) replaces " + strings.Join(refs, ", ") + ": " + item.Text
	}
	return "Context " + label + " (internal reference, never spoken): " + item.Text
}

func (s *session) notify() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// Called under the context ledger lock; absolute expiry never waits for a prefix.
func (s *session) due() bool {
	for _, entry := range s.commands {
		if entry.reserved && entry.finished && entry.err == nil && !entry.invalidated && !entry.expiry.After(time.Now()) {
			return true
		}
	}
	return false
}

// One scheduler owns all accepted factual expiries and their bounded sends.
func (s *session) expire() {
	defer close(s.lifecycle)
	timer := time.NewTimer(time.Hour)
	defer timer.Stop()
	for {
		if s.closed.Load() || s.parent.Err() != nil {
			return
		}
		s.mu.Lock()
		var next *command
		for _, id := range s.order {
			entry := s.commands[id]
			if !s.prefilling && entry.reserved && entry.finished && entry.err == nil && !entry.invalidated && (next == nil || entry.expiry.Before(next.expiry)) {
				next = entry
			}
		}
		wait := time.Hour
		if next != nil {
			wait = time.Until(next.expiry)
		}
		if wait <= 0 {
			next.invalidated = true
			id, err := random()
			if err != nil {
				s.mu.Unlock()
				s.fail("GPT-Live context invalidation could not be prepared")
				return
			}
			item := engine.ContextItem{ID: "expiry_" + id, Kind: "fact", Text: "This context has expired.", Created: next.expiry, Replaces: []string{next.item.ID}}
			record := engine.ContextRecord{Item: clone(item), Label: "fact_" + id, Expired: next.item.ID}
			record.Content = projection(item, record.Label, nil, next.record.Label)
			s.mu.Unlock()
			ctx, cancel := context.WithTimeout(s.ctx, startup)
			s.paused.Store(true)
			// Drop only owned queued ingress, not provider generation or heard audio.
			if err := s.clock.Drop(ctx, *s.source.Load()); err != nil {
				cancel()
				s.fail("GPT-Live context expiry media fence is unconfirmed")
				return
			}
			err = s.project(ctx, item, "", &record, false, false)
			cancel()
			if err != nil {
				s.fail("GPT-Live context invalidation acceptance is unconfirmed")
				return
			}
			// A new local ingress identity permits post-ACK bytes. It makes no
			// claim about provider recomputation, turn boundaries or playback.
			if s.closed.Load() || s.parent.Err() != nil {
				return
			}
			s.mu.Lock()
			due := s.due()
			source := "local_" + id
			if !due {
				s.source.Store(&source)
				s.paused.Store(false)
			}
			s.mu.Unlock()
			s.emit(engine.Event{Type: "context.expired", Item: next.item.ID, Data: map[string]any{"accepted": true, "speechPlayed": false}})
			continue
		}
		s.mu.Unlock()
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(wait)
		select {
		case <-s.wake:
		case <-timer.C:
		case <-s.ctx.Done():
			return
		case <-s.parent.Done():
			return
		}
	}
}

// Validate every projected record and relationship before the first wire effect.
func records(snapshot engine.Snapshot) ([]engine.ContextRecord, map[string]bool, error) {
	if len(snapshot.Items) > 256 || len(snapshot.Context) > 256 || snapshot.Version < 0 || snapshot.Version > 1 {
		return nil, nil, errors.New("invalid context snapshot version or allowance")
	}
	if snapshot.Version == 0 {
		if len(snapshot.Context) != 0 {
			return nil, nil, errors.New("unversioned context projections")
		}
		out := make([]engine.ContextRecord, 0, len(snapshot.Items))
		seen := map[string]bool{}
		for _, item := range snapshot.Items {
			if !valid(item) || seen[item.ID] || item.Created.IsZero() || item.TTLMS != 0 || item.Supersedes != "" || len(item.Replaces) != 0 {
				return nil, nil, errors.New("legacy context lifecycle cannot be upgraded")
			}
			seen[item.ID] = true
			out = append(out, engine.ContextRecord{Item: clone(item), Content: item.Text})
		}
		return out, map[string]bool{}, nil
	}
	if len(snapshot.Items) != len(snapshot.Context) {
		return nil, nil, errors.New("context snapshot views disagree")
	}
	seen := map[string]engine.ContextRecord{}
	labels := map[string]bool{}
	expired := map[string]bool{}
	out := make([]engine.ContextRecord, 0, len(snapshot.Context))
	for index, record := range snapshot.Context {
		item := record.Item
		if !valid(item) || !same(item, snapshot.Items[index]) || seen[item.ID].Item.ID != "" || item.Created.IsZero() {
			return nil, nil, errors.New("invalid context snapshot identity")
		}
		refs, err := targets(item)
		if err != nil {
			return nil, nil, err
		}
		aliases := make([]string, 0, len(refs))
		for _, ref := range refs {
			prior, exists := seen[ref]
			if !exists || prior.Label == "" || prior.Expired != "" || expired[ref] {
				return nil, nil, errors.New("invalid context snapshot target")
			}
			aliases = append(aliases, prior.Label)
		}
		content := item.Text
		if record.Label != "" {
			if !strings.HasPrefix(record.Label, "fact_") || !identifier(record.Label) || labels[record.Label] || !factual(item) {
				return nil, nil, errors.New("invalid context snapshot label")
			}
			labels[record.Label] = true
			content = projection(item, record.Label, aliases, "")
		}
		if record.Expired != "" {
			if len(refs) != 1 || refs[0] != record.Expired || record.Label == "" || item.Kind != "fact" || item.Text != "This context has expired." || item.TTLMS != 0 {
				return nil, nil, errors.New("invalid context snapshot invalidation")
			}
			prior := seen[record.Expired].Item
			if prior.TTLMS <= 0 || !item.Created.Equal(prior.Created.Add(time.Duration(prior.TTLMS)*time.Millisecond)) {
				return nil, nil, errors.New("context snapshot expiry changed")
			}
			content = projection(item, record.Label, nil, aliases[0])
			expired[record.Expired] = true
		}
		if content != record.Content || len(content) > 500 || (record.Label == "" && (len(refs) != 0 || (item.TTLMS != 0 && factual(item)))) {
			return nil, nil, errors.New("context snapshot projection changed")
		}
		record.Item = clone(item)
		out = append(out, record)
		seen[item.ID] = record
	}
	for _, record := range out {
		item := record.Item
		if record.Label != "" && item.TTLMS > 0 && !item.Created.Add(time.Duration(item.TTLMS)*time.Millisecond).After(time.Now()) && !expired[item.ID] {
			return nil, nil, errors.New("expired snapshot lacks accepted invalidation")
		}
	}
	return out, expired, nil
}

func same(a, b engine.ContextItem) bool {
	return a.ID == b.ID && a.Kind == b.Kind && a.Text == b.Text && a.Call == b.Call && a.TTLMS == b.TTLMS && a.Created.Equal(b.Created) && a.Supersedes == b.Supersedes && reflect.DeepEqual(a.Replaces, b.Replaces)
}
