// raya_change - Two-plane session runner joining realtime media to deadline-bounded async events.
package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/room"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/wire"
)

type Session struct {
	id         string
	engine     engine.Session
	cfg        engine.Descriptor
	room       room.Room
	backend    Backend
	ctx        context.Context
	cancel     context.CancelFunc
	wait       sync.WaitGroup
	seq        atomic.Uint64
	queue      chan wire.Envelope
	speaking   atomic.Bool
	generating atomic.Bool
	heardMu    sync.RWMutex
	heard      wire.Playout
	client     string
	published  wire.Span
	spans      map[uint64]wire.Span
	proof      bool
	fenced     uint64
	stopped    bool
	epoch      uint64
	frame      uint64
	turn       string
	closed     error
	done       chan struct{}
	statusMu   sync.RWMutex
	status     wire.Status
}

func NewSession(ctx context.Context, id string, voice engine.Session, media room.Room, backend Backend, client ...string) *Session {
	identity := ""
	if len(client) == 1 {
		identity = client[0]
	}
	return NewSessionWithDescriptor(ctx, id, voice, media, backend, identity, engine.Descriptor{})
}

func NewSessionWithDescriptor(ctx context.Context, id string, voice engine.Session, media room.Room, backend Backend, client string, cfg engine.Descriptor) *Session {
	run, cancel := context.WithCancel(ctx)
	session := &Session{
		id: id, engine: voice, room: media, backend: backend, ctx: run, cancel: cancel,
		queue:  make(chan wire.Envelope, 64),
		done:   make(chan struct{}),
		status: wire.Status{ID: id, State: "active"},
		spans:  make(map[uint64]wire.Span),
		client: client,
		cfg:    cfg,
	}
	session.status.RoomReport = "not_attempted"
	session.status.BackendReport = "not_configured"
	if backend != nil {
		session.status.BackendReport = "not_attempted"
	}
	if cfg != (engine.Descriptor{}) && (cfg.ID != "openai-live" || !cfg.RequiresContinuousInput || !cfg.NativeBargeIn || cfg.InputRate != 24000 || cfg.OutputRate != 24000) {
		session.fail("audio_input")
	}
	session.wait.Add(4)
	go session.input()
	go session.output()
	go session.events()
	go session.forward()
	go session.finish()
	return session
}

func (s *Session) Inject(ctx context.Context, item engine.ContextItem) error {
	if s.ctx.Err() != nil {
		return context.Canceled
	}
	err := s.engine.Inject(ctx, item)
	if err != nil {
		s.fail("engine_inject")
		return errors.New("Task context could not reach the voice engine. Reconnect with the selected provider, or continue typing.")
	}
	return nil
}

func (s *Session) Result(ctx context.Context, result engine.Result) error {
	if s.ctx.Err() != nil {
		return context.Canceled
	}
	delegator, ok := s.engine.(engine.Delegator)
	if !ok {
		return errors.New("selected voice engine does not support client delegation results")
	}
	return delegator.Result(ctx, result)
}

func (s *Session) Stats() engine.Stats {
	return s.engine.Stats()
}

func (s *Session) Close() error {
	s.cancel()
	<-s.done
	return s.closed
}

func (s *Session) input() {
	defer s.wait.Done()
	for {
		select {
		case <-s.ctx.Done():
			return
		case data, ok := <-s.room.Data():
			if !ok {
				s.fail("room_data_closed")
				return
			}
			if data.Topic != "raya.playout" {
				continue
			}
			s.report(data)
		case frame, ok := <-s.room.Input():
			if !ok {
				s.fail("room_input_closed")
				return
			}
			if s.cfg.RequiresContinuousInput && (s.cfg.InputRate < 8000 || s.cfg.InputRate > 48000 ||
				s.cfg.InputRate%50 != 0 || frame.Rate != s.cfg.InputRate || len(frame.PCM) != s.cfg.InputRate/50*2) {
				s.fail("audio_input")
				return
			}
			if !s.cfg.RequiresContinuousInput && !s.cfg.NativeBargeIn && audible(frame.PCM, 0.025) && s.speaking.Load() {
				s.barge()
				if s.ctx.Err() != nil {
					return
				}
			}
			ctx, cancel := context.WithTimeout(s.ctx, 40*time.Millisecond)
			err := s.engine.PushAudio(ctx, frame.PCM)
			cancel()
			if err != nil {
				s.fail("audio_input")
				return
			}
		}
	}
}

func (s *Session) output() {
	defer s.wait.Done()
	for {
		select {
		case <-s.ctx.Done():
			return
		case frame, ok := <-s.engine.Audio():
			if !ok {
				s.fail("engine_audio_closed")
				return
			}
			if !s.publish(frame) {
				return
			}
		}
	}
}

// Publication and local interruption share one fence. Sent audio is only a bound;
// it is never evidence that a client rendered or heard it.
func (s *Session) publish(frame engine.Frame) bool {
	s.heardMu.Lock()
	defer s.heardMu.Unlock()
	if s.ctx.Err() != nil {
		return false
	}
	if s.stopped || (s.fenced != 0 && frame.Epoch <= s.fenced) {
		return true
	}
	if !validFrame(frame) || (s.cfg.OutputRate != 0 && frame.Rate != s.cfg.OutputRate) || frame.Seq <= s.frame || frame.Epoch < s.epoch {
		s.fail("playout_metadata")
		return false
	}
	if frame.Item != "" && (s.published.Item != frame.Item || s.published.Epoch != frame.Epoch) {
		if frame.Start != 0 {
			s.fail("playout_metadata")
			return false
		}
		s.spans = make(map[uint64]wire.Span)
		s.heard = wire.Playout{}
		s.proof = false
		s.published = wire.Span{}
	}
	if frame.Item != "" && s.published.Item != "" &&
		(frame.Start != s.published.End || frame.Rate != s.published.Rate || frame.Turn != s.published.Turn || s.published.Final) {
		s.fail("playout_metadata")
		return false
	}
	if frame.Final && frame.Start == frame.End && (s.published.Item == "" || frame.End != s.published.End) {
		s.fail("playout_metadata")
		return false
	}
	version := 2
	if frame.Turn != "" {
		version = 3
	}
	span := wire.Span{Version: version, Session: s.id, Item: frame.Item, Epoch: frame.Epoch, Seq: frame.Seq,
		Start: frame.Start, End: frame.End, Rate: frame.Rate, Turn: frame.Turn, Final: frame.Final}
	ctx, cancel := context.WithTimeout(s.ctx, engine.FramePeriod)
	defer cancel()
	if frame.Item != "" {
		raw, _ := json.Marshal(span)
		if err := s.room.Send(ctx, room.Data{Topic: "raya.playout.item", Body: raw}); err != nil {
			s.fail("playout_metadata")
			return false
		}
	}
	if err := s.room.Publish(ctx, frame); err != nil {
		s.fail("audio_publish")
		return false
	}
	s.frame, s.epoch = frame.Seq, frame.Epoch
	if frame.Item != "" {
		s.published = span
		s.spans[frame.Seq] = span
		for seq := range s.spans {
			if frame.Seq-seq >= 256 {
				delete(s.spans, seq)
			}
		}
		s.speaking.Store(true)
	}
	return true
}

func validFrame(frame engine.Frame) bool {
	if frame.Epoch == 0 || frame.Seq == 0 || frame.Epoch > 1<<53-1 || frame.Seq > 1<<53-1 ||
		frame.Rate < 8000 || frame.Rate > 48000 || frame.Rate%50 != 0 || len(frame.PCM) != frame.Rate/50*2 {
		return false
	}
	if frame.Item == "" {
		return frame.Start == 0 && frame.End == 0 && frame.Turn == "" && !frame.Final
	}
	if len(frame.Turn) > 256 || (frame.Final && frame.Turn == "") {
		return false
	}
	if frame.Final && frame.Start == frame.End {
		for _, value := range frame.PCM {
			if value != 0 {
				return false
			}
		}
	}
	return len(frame.Item) <= 256 && (frame.End > frame.Start || (frame.Final && frame.End == frame.Start)) && frame.End <= 1<<53-1 &&
		frame.End-frame.Start <= uint64(len(frame.PCM)/2)
}

func (s *Session) report(data room.Data) {
	if s.client == "" || data.Identity != s.client || len(data.Body) > 4096 {
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(data.Body))
	decoder.DisallowUnknownFields()
	var heard wire.Playout
	var extra any
	if decoder.Decode(&heard) != nil || decoder.Decode(&extra) != io.EOF {
		return
	}
	s.heardMu.Lock()
	defer s.heardMu.Unlock()
	span, exists := s.spans[heard.Seq]
	if !exists || heard.Version != span.Version || heard.Session != s.id || heard.Item != s.published.Item ||
		heard.Epoch != s.published.Epoch || heard.Epoch <= s.fenced || heard.Item != span.Item ||
		heard.Epoch != span.Epoch || heard.Rate != span.Rate || heard.Samples < span.Start ||
		heard.Samples > span.End || heard.Jitter < 0 || heard.Jitter > 2000 ||
		heard.Turn != span.Turn || heard.Turn != s.published.Turn ||
		(heard.Final && (!span.Final || heard.Samples != span.End || heard.Seq != s.published.Seq)) ||
		(s.proof && (heard.Seq < s.heard.Seq || heard.Samples < s.heard.Samples)) {
		return
	}
	s.heard = heard
	s.proof = true
	s.settle()
}

// Called under heardMu: only the exact sealed source boundary and client receipt
// can settle the latest response, never generation completion alone.
func (s *Session) settle() {
	if !s.generating.Load() && s.final() && s.published.Turn == s.turn {
		s.speaking.Store(false)
	}
}

func (s *Session) final() bool {
	return s.proof && s.heard.Version == 3 && s.heard.Final && s.published.Final &&
		s.published.Turn != "" && s.heard.Turn == s.published.Turn && s.heard.Seq == s.published.Seq &&
		s.heard.Samples == s.published.End && s.heard.Item == s.published.Item &&
		s.heard.Epoch == s.published.Epoch && s.heard.Rate == s.published.Rate
}

func (s *Session) events() {
	defer s.wait.Done()
	for {
		select {
		case <-s.ctx.Done():
			return
		case event, ok := <-s.engine.Events():
			if !ok {
				s.fail("engine_events_closed")
				return
			}
			if _, terminal := s.engine.(engine.Terminal); terminal && event.Type == "session.closed" {
				continue
			}
			if event.Type == "engine.error" {
				s.fail("engine_failure")
				return
			}
			if event.Type == "response.created" {
				s.heardMu.Lock()
				s.turn = event.Turn
				s.generating.Store(true)
				s.speaking.Store(true)
				s.heardMu.Unlock()
			}
			if event.Type == "response.done" || event.Type == "response.interrupted" {
				s.heardMu.Lock()
				if event.Turn != "" && event.Turn == s.turn {
					s.generating.Store(false)
					s.settle()
					empty, known := event.Data["audioEmpty"].(bool)
					if event.Type == "response.done" && known && empty && (s.published.Item == "" || s.final()) {
						s.speaking.Store(false)
					}
				}
				s.heardMu.Unlock()
			}
			if event.Type == "transcript.input.delta" || event.Type == "transcript.input.done" ||
				event.Type == "transcript.output.delta" || event.Type == "transcript.output.done" {
				raw, _ := json.Marshal(wire.Transcript{
					Type:   event.Type,
					Turn:   event.Turn,
					Item:   event.Item,
					Text:   event.Text,
					Stable: event.Stable,
				})
				ctx, cancel := context.WithTimeout(s.ctx, 40*time.Millisecond)
				err := s.room.Send(ctx, room.Data{Topic: "raya.transcript", Body: raw})
				cancel()
				if err != nil {
					s.fail("transcript_send")
					return
				}
			}
			s.enqueue(event)
		}
	}
}

func (s *Session) barge() {
	ctx, cancel := context.WithTimeout(s.ctx, 100*time.Millisecond)
	defer cancel()
	s.heardMu.Lock()
	playout := s.heard
	item := s.published.Item
	confirmed := s.proof && playout.Item == item && playout.Epoch == s.published.Epoch
	heard, valid := duration(playout)
	// Fence publication before flushing. Already-buffered source frames cannot escape
	// the local stop while the provider handles its cancellation.
	s.fenced = s.epoch
	s.stopped = true
	s.proof = false
	s.spans = make(map[uint64]wire.Span)
	s.speaking.Store(false)
	s.heardMu.Unlock()
	if err := s.room.Flush(ctx, item); err != nil {
		s.fail("playout_flush")
		return
	}
	if !confirmed || !valid {
		s.fail("playout_unconfirmed")
		return
	}
	if err := s.engine.Interrupt(ctx, "barge-in", heard); err != nil {
		s.fail("engine_interrupt")
		return
	}
	s.heardMu.Lock()
	s.stopped = false
	s.heardMu.Unlock()
	raw, _ := json.Marshal(wire.Discontinuity{Type: "discontinuity", Item: playout.Item, HeardMS: heard.Milliseconds()})
	if err := s.room.Send(ctx, room.Data{Topic: "raya.control", Body: raw}); err != nil {
		s.fail("interruption_send")
		return
	}
	s.speaking.Store(false)
}

func duration(playout wire.Playout) (time.Duration, bool) {
	if playout.Rate < 8000 || playout.Rate > 48000 {
		return 0, false
	}
	rate := uint64(playout.Rate)
	seconds := playout.Samples / rate
	if seconds > uint64(math.MaxInt64/int64(time.Second)) {
		return 0, false
	}
	base := time.Duration(seconds) * time.Second
	rest := time.Duration(playout.Samples%rate) * time.Second / time.Duration(rate)
	if base > time.Duration(math.MaxInt64)-rest {
		return 0, false
	}
	return base + rest, true
}

func (s *Session) enqueue(event engine.Event) {
	if s.backend == nil {
		return
	}
	event.Seq = s.seq.Add(1)
	envelope := wire.Envelope{Session: s.id, Seq: event.Seq, Event: event}
	select {
	case s.queue <- envelope:
	default:
		s.fail("event_queue_overflow")
	}
}

func (s *Session) forward() {
	defer s.wait.Done()
	for {
		select {
		case <-s.ctx.Done():
			return
		case envelope := <-s.queue:
			ctx, cancel := context.WithTimeout(s.ctx, 150*time.Millisecond)
			err := s.backend.Event(ctx, envelope)
			cancel()
			if err != nil {
				s.fail("backend_delivery")
				return
			}
		}
	}
}

func audible(pcm []byte, threshold float64) bool {
	if len(pcm) < 2 {
		return false
	}
	var sum float64
	count := len(pcm) / 2
	for index := 0; index < count; index++ {
		value := int16(uint16(pcm[index*2]) | uint16(pcm[index*2+1])<<8)
		sample := float64(value) / 32768
		sum += sample * sample
	}
	return math.Sqrt(sum/float64(count)) >= threshold
}
