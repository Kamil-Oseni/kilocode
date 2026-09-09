// raya_change - Two-plane session runner joining realtime media to deadline-bounded async events.
package app

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/room"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/wire"
)

type Session struct {
	id       string
	engine   engine.Session
	room     room.Room
	backend  Backend
	ctx      context.Context
	cancel   context.CancelFunc
	wait     sync.WaitGroup
	seq      atomic.Uint64
	queue    chan wire.Envelope
	speaking atomic.Bool
	heardMu  sync.RWMutex
	heard    wire.Playout
	closed   error
	done     chan struct{}
	statusMu sync.RWMutex
	status   wire.Status
}

func NewSession(ctx context.Context, id string, voice engine.Session, media room.Room, backend Backend) *Session {
	run, cancel := context.WithCancel(ctx)
	session := &Session{
		id: id, engine: voice, room: media, backend: backend, ctx: run, cancel: cancel,
		queue:  make(chan wire.Envelope, 64),
		done:   make(chan struct{}),
		status: wire.Status{ID: id, State: "active"},
	}
	session.status.RoomReport = "not_attempted"
	session.status.BackendReport = "not_configured"
	if backend != nil {
		session.status.BackendReport = "not_attempted"
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
	active := false
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
			var heard wire.Playout
			if json.Unmarshal(data.Body, &heard) == nil {
				s.heardMu.Lock()
				s.heard = heard
				s.heardMu.Unlock()
			}
		case frame, ok := <-s.room.Input():
			if !ok {
				s.fail("room_input_closed")
				return
			}
			speech := audible(frame.PCM, 0.025)
			if speech && !active {
				active = true
				if s.speaking.Load() {
					s.barge()
					if s.ctx.Err() != nil {
						return
					}
				}
			}
			if !speech {
				active = false
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
	item := ""
	for {
		select {
		case <-s.ctx.Done():
			return
		case frame, ok := <-s.engine.Audio():
			if !ok {
				s.fail("engine_audio_closed")
				return
			}
			ctx, cancel := context.WithTimeout(s.ctx, engine.FramePeriod)
			if frame.Item != "" && frame.Item != item {
				item = frame.Item
				raw, _ := json.Marshal(map[string]string{"item": item})
				if err := s.room.Send(ctx, room.Data{Topic: "raya.playout.item", Body: raw}); err != nil {
					cancel()
					s.fail("playout_metadata")
					return
				}
			}
			err := s.room.Publish(ctx, frame)
			cancel()
			if err != nil {
				s.fail("audio_publish")
				return
			}
		}
	}
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
			if event.Type == "engine.error" {
				s.fail("engine_failure")
				return
			}
			if event.Type == "response.created" {
				s.speaking.Store(true)
			}
			if event.Type == "response.done" || event.Type == "response.interrupted" {
				s.speaking.Store(false)
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
	s.heardMu.RLock()
	playout := s.heard
	s.heardMu.RUnlock()
	rate := playout.Rate
	if rate == 0 {
		rate = 24000
	}
	heard := time.Duration(playout.Samples*1000/uint64(rate)) * time.Millisecond
	ctx, cancel := context.WithTimeout(s.ctx, 100*time.Millisecond)
	defer cancel()
	flushed := s.room.Flush(ctx, playout.Item)
	interrupted := s.engine.Interrupt(ctx, "barge-in", heard)
	if flushed != nil {
		s.fail("playout_flush")
		return
	}
	if interrupted != nil {
		s.fail("engine_interrupt")
		return
	}
	raw, _ := json.Marshal(wire.Discontinuity{Type: "discontinuity", Item: playout.Item, HeardMS: heard.Milliseconds()})
	if err := s.room.Send(ctx, room.Data{Topic: "raya.control", Body: raw}); err != nil {
		s.fail("interruption_send")
		return
	}
	s.speaking.Store(false)
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
