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
	once     sync.Once
}

func NewSession(ctx context.Context, id string, voice engine.Session, media room.Room, backend Backend) *Session {
	run, cancel := context.WithCancel(ctx)
	session := &Session{
		id: id, engine: voice, room: media, backend: backend, ctx: run, cancel: cancel,
		queue: make(chan wire.Envelope, 64),
	}
	session.wait.Add(4)
	go session.input()
	go session.output()
	go session.events()
	go session.forward()
	return session
}

func (s *Session) Inject(ctx context.Context, item engine.ContextItem) error {
	return s.engine.Inject(ctx, item)
}

func (s *Session) Stats() engine.Stats {
	return s.engine.Stats()
}

func (s *Session) Close() error {
	var errs []error
	s.once.Do(func() {
		s.cancel()
		errs = append(errs, s.room.Close(), s.engine.Close())
		s.wait.Wait()
	})
	return errors.Join(errs...)
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
				return
			}
			speech := audible(frame.PCM, 0.025)
			if speech && !active {
				active = true
				if s.speaking.Load() {
					s.barge(frame.Item)
				}
			}
			if !speech {
				active = false
			}
			ctx, cancel := context.WithTimeout(s.ctx, 40*time.Millisecond)
			_ = s.engine.PushAudio(ctx, frame.PCM)
			cancel()
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
				return
			}
			ctx, cancel := context.WithTimeout(s.ctx, engine.FramePeriod)
			if frame.Item != "" && frame.Item != item {
				item = frame.Item
				raw, _ := json.Marshal(map[string]string{"item": item})
				_ = s.room.Send(ctx, room.Data{Topic: "raya.playout.item", Body: raw})
			}
			_ = s.room.Publish(ctx, frame)
			cancel()
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
				_ = s.room.Send(ctx, room.Data{Topic: "raya.transcript", Body: raw})
				cancel()
			}
			s.enqueue(event)
		}
	}
}

func (s *Session) barge(item string) {
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
	_ = s.room.Flush(ctx, item)
	_ = s.engine.Interrupt(ctx, "barge-in", heard)
	raw, _ := json.Marshal(wire.Discontinuity{Type: "discontinuity", Item: playout.Item, HeardMS: heard.Milliseconds()})
	_ = s.room.Send(ctx, room.Data{Topic: "raya.control", Body: raw})
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
			_ = s.backend.Event(ctx, envelope)
			cancel()
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
