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
	item        engine.ContextItem
	wire        string
	kind        string
	done        chan struct{}
	timer       *time.Timer
	finished    bool
	err         error
	delegation  string
	record      *engine.ContextRecord
	expiry      time.Time
	reserved    bool
	invalidated bool
	attempted   bool
}

func (s *session) Inject(ctx context.Context, item engine.ContextItem) error {
	return s.append(ctx, item, "")
}

func (s *session) Result(ctx context.Context, result engine.Result) error {
	if !identifier(result.DelegationID) || (result.Kind != "delegation.result" && result.Kind != "commentary" && result.Kind != "thinking") {
		return errors.New("invalid GPT-Live delegation result")
	}
	return s.append(ctx, engine.ContextItem{ID: result.ReceiptID, Kind: result.Kind, Text: result.Content, TTLMS: result.TTLMS, Created: result.Created}, result.DelegationID)
}

func (s *session) append(ctx context.Context, item engine.ContextItem, original string) error {
	return s.project(ctx, item, original, nil, false, false)
}

func (s *session) project(ctx context.Context, item engine.ContextItem, original string, record *engine.ContextRecord, historical bool, prefix bool) error {
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
	if _, err := targets(item); err != nil {
		return err
	}
	item = clone(item)
	s.mu.Lock()
	if s.prefilling && !prefix {
		s.mu.Unlock()
		return errors.New("GPT-Live context prefix is owned by prefill")
	}
	if original != "" {
		_, exists := s.delegations[original]
		if s.cfg.Delegation != "client" || !exists {
			s.mu.Unlock()
			return errors.New("GPT-Live result does not match an original client delegation")
		}
	}
	prior := s.commands[item.ID]
	if item.Created.IsZero() {
		item.Created = time.Now()
		if prior != nil {
			item.Created = prior.item.Created
		}
	}
	item.Created = item.Created.UTC()
	if prior != nil {
		match := same(prior.item, item) && prior.delegation == original
		s.mu.Unlock()
		if !match {
			return errors.New("GPT-Live context identity was reused")
		}
		return s.await(ctx, prior)
	}
	generic := original == "" && factual(item)
	if !generic && (item.Supersedes != "" || len(item.Replaces) != 0 || (record != nil && record.Label != "")) {
		s.mu.Unlock()
		return errors.New("task result context cannot supersede generic facts")
	}
	reserve := generic && item.TTLMS > 0 && !historical
	if record != nil && record.Expired != "" && !historical {
		prior := s.commands[record.Expired]
		if prior == nil || !prior.reserved {
			s.mu.Unlock()
			return errors.New("context invalidation lacks reserved capacity")
		}
		prior.reserved = false
		s.reserved--
	}
	allowance := 1
	if reserve {
		allowance++
	}
	if len(s.commands)+s.reserved+allowance > 256 {
		s.mu.Unlock()
		return errors.New("GPT-Live context identity allowance exhausted")
	}
	id, err := random()
	if err != nil {
		s.mu.Unlock()
		return err
	}
	if generic && record == nil {
		label := "fact_" + id
		labels := make([]string, 0, 8)
		refs, _ := targets(item)
		for _, ref := range refs {
			prior := s.commands[ref]
			if prior == nil || prior.record == nil || prior.record.Label == "" || prior.record.Expired != "" || !prior.finished || prior.err != nil || prior.invalidated || ref == item.ID {
				s.mu.Unlock()
				return errors.New("supersession target is not accepted live generic context")
			}
			labels = append(labels, prior.record.Label)
		}
		content := projection(item, label, labels, "")
		if len(content) > 500 {
			s.mu.Unlock()
			return errors.New("GPT-Live context projection exceeds byte allowance")
		}
		record = &engine.ContextRecord{Item: clone(item), Label: label, Content: content}
	}
	kind := "session.thinking.append"
	if item.Kind == "instructions" {
		kind = "session.instructions.append"
	}
	if item.Kind == "commentary" || item.Kind == "delegation.result" {
		kind = "session.commentary.append"
	}
	entry := &command{item: item, wire: "context_" + id, kind: kind, delegation: original, record: record, reserved: reserve, done: make(chan struct{})}
	if reserve {
		entry.expiry = item.Created.Add(time.Duration(item.TTLMS) * time.Millisecond)
		s.reserved++
	}
	s.commands[item.ID] = entry
	end := time.Now().Add(startup)
	if !historical && item.TTLMS > 0 && item.Created.Add(time.Duration(item.TTLMS)*time.Millisecond).Before(end) {
		end = item.Created.Add(time.Duration(item.TTLMS) * time.Millisecond)
	}
	if !end.After(time.Now()) {
		entry.err = errors.New("GPT-Live context expired before sending")
		entry.finished = true
		close(entry.done)
		s.mu.Unlock()
		s.notify()
		s.emit(engine.Event{Type: "context.expired", Item: item.ID})
		return entry.err
	}
	entry.timer = time.AfterFunc(time.Until(end), func() { s.complete(entry, errAppend) })
	s.mu.Unlock()
	// Generic ContextItem.Call is not a provider Live delegation ID. Keep
	// private receipt identity in the local record, not speakable content.
	send, cancel := context.WithDeadline(ctx, end)
	defer cancel()
	var target any
	if original != "" {
		target = original
	}
	content := item.Text
	if record != nil {
		content = record.Content
	}
	if err := s.send(send, map[string]any{"type": kind, "event_id": entry.wire, "delegation_id": target, "content": content}, func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		valid := !entry.finished && time.Now().Before(end)
		if valid {
			// The owned writer gate establishes submitted prefix order. Ledger
			// admission may occur in a different concurrent scheduling order.
			s.order = append(s.order, item.ID)
			entry.attempted = true
		}
		return valid
	}); err != nil {
		s.complete(entry, errors.Join(errAppend, err))
	}
	err = s.await(ctx, entry)
	s.mu.Lock()
	attempted := entry.attempted
	s.mu.Unlock()
	correction := item.Supersedes != "" || len(item.Replaces) != 0
	if err != nil && generic && (((reserve || correction) && attempted) || record.Expired != "") {
		s.fail("GPT-Live context lifecycle acceptance is unconfirmed")
	}
	return err
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
	s.notify()
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
	context := make([]engine.ContextRecord, 0, len(s.commands))
	// Refusals before writer admission have no order entry, but must still
	// prevent an incomplete ledger from becoming a replayable snapshot.
	for _, entry := range s.commands {
		if !entry.finished || entry.err != nil {
			return engine.Snapshot{}, errors.New("context snapshot has unresolved append outcomes")
		}
	}
	for _, id := range s.order {
		entry := s.commands[id]
		if entry.finished && entry.err == nil && entry.delegation == "" {
			items = append(items, clone(entry.item))
			record := engine.ContextRecord{Item: clone(entry.item), Content: entry.item.Text}
			if entry.record != nil {
				record = *entry.record
				record.Item = clone(record.Item)
			}
			context = append(context, record)
		}
	}
	snapshot := engine.Snapshot{Version: 1, Items: items, Context: context}
	if _, _, err := records(snapshot); err != nil {
		return engine.Snapshot{}, err
	}
	return snapshot, nil
}

func (s *session) Prefill(ctx context.Context, snapshot engine.Snapshot) (err error) {
	context, expired, err := records(snapshot)
	if err != nil {
		return err
	}
	allowance := len(context)
	for _, record := range context {
		item := record.Item
		if !factual(item) {
			return errors.New("GPT-Live result context cannot be replayed through generic prefill")
		}
		if item.TTLMS > 0 && !expired[item.ID] {
			allowance++
		}
	}
	s.mu.Lock()
	available := len(s.commands) == 0 && !s.prefilling && allowance <= 256
	if !available {
		s.mu.Unlock()
		return errors.New("GPT-Live prefill requires empty bounded context")
	}
	s.prefilling = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.prefilling = false
		partial := len(s.commands) != 0
		s.mu.Unlock()
		s.notify()
		if err != nil && partial {
			s.fail("GPT-Live partial context prefill is unconfirmed; do not replay")
		}
	}()
	source := ""
	if len(context) != 0 {
		id, failure := random()
		if failure != nil {
			return failure
		}
		source = "local_" + id
		s.paused.Store(true)
		if err := s.clock.Drop(ctx, *s.source.Load()); err != nil {
			s.fail("GPT-Live prefill media fence is unconfirmed")
			return err
		}
	}
	for _, record := range context {
		historical := expired[record.Item.ID] || record.Expired != ""
		if err := s.project(ctx, record.Item, "", &record, historical, true); err != nil {
			return err
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.closed.Load() || s.parent.Err() != nil {
		return errors.New("GPT-Live prefill ended after session fencing")
	}
	if source != "" {
		// Restore only local ingress after the complete exact-ACK prefix.
		// This does not prove provider recomputation or audible playback.
		s.mu.Lock()
		due := s.due()
		if !due {
			s.source.Store(&source)
			s.paused.Store(false)
		}
		s.mu.Unlock()
	}
	return nil
}
