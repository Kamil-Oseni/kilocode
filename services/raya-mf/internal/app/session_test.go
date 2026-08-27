// raya_change - Barge-in and playout-accounting conformance for Raya's media session.
package app

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/room"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/wire"
)

func TestBargeInFlushesAndCancelsWithinBudget(t *testing.T) {
	voice := newFakeEngine()
	media := newFakeRoom()
	backend := &fakeBackend{events: make(chan wire.Envelope, 8)}
	session := NewSession(context.Background(), "test", voice, media, backend)
	defer session.Close()

	voice.events <- engine.Event{Type: "response.created"}
	<-backend.events
	playout, _ := json.Marshal(wire.Playout{Item: "assistant-1", Samples: 12000, Rate: 24000})
	media.data <- room.Data{Topic: "raya.playout", Body: playout}
	pcm := make([]byte, 640)
	for index := 0; index < len(pcm); index += 2 {
		pcm[index] = 0xff
		pcm[index+1] = 0x3f
	}

	started := time.Now()
	media.input <- engine.Frame{PCM: pcm, Rate: 16000}
	select {
	case heard := <-voice.interrupted:
		if heard != 500*time.Millisecond {
			t.Fatalf("heard = %s, want 500ms", heard)
		}
		if time.Since(started) >= 100*time.Millisecond {
			t.Fatalf("barge-in took %s", time.Since(started))
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("barge-in did not cancel within 100ms")
	}
	select {
	case <-media.flushed:
	default:
		t.Fatal("playout was not flushed")
	}
}

func TestBackendEventsStayOrdered(t *testing.T) {
	voice := newFakeEngine()
	media := newFakeRoom()
	backend := &fakeBackend{events: make(chan wire.Envelope, 32)}
	session := NewSession(context.Background(), "ordered", voice, media, backend)
	defer session.Close()

	for index := range 20 {
		voice.events <- engine.Event{Type: "transcript.input.delta", Text: string(rune('a' + index))}
	}
	for index := range 20 {
		select {
		case event := <-backend.events:
			want := uint64(index + 1)
			if event.Seq != want || event.Event.Seq != want {
				t.Fatalf("event %d = envelope %d / payload %d", index, event.Seq, event.Event.Seq)
			}
		case <-time.After(time.Second):
			t.Fatalf("timed out waiting for event %d", index)
		}
	}
}

func TestStreamedAudioCarriesPlayoutItemsAcrossTurns(t *testing.T) {
	voice := newFakeEngine()
	media := newFakeRoom()
	session := NewSession(context.Background(), "playout", voice, media, nil)
	defer session.Close()

	for _, item := range []string{"assistant-1", "assistant-2"} {
		voice.audio <- engine.Frame{Item: item, PCM: make([]byte, 960), Rate: 24000}
		select {
		case data := <-media.sent:
			if data.Topic != "raya.playout.item" {
				t.Fatalf("topic = %q", data.Topic)
			}
			var got map[string]string
			if err := json.Unmarshal(data.Body, &got); err != nil || got["item"] != item {
				t.Fatalf("item packet = %q / %v", data.Body, err)
			}
		case <-time.After(time.Second):
			t.Fatalf("timed out waiting for item %q", item)
		}
		select {
		case frame := <-media.published:
			if frame.Item != item || frame.Rate != 24000 {
				t.Fatalf("published frame = %#v", frame)
			}
		case <-time.After(time.Second):
			t.Fatalf("timed out waiting for audio %q", item)
		}
	}
}

type fakeEngine struct {
	audio       chan engine.Frame
	events      chan engine.Event
	interrupted chan time.Duration
}

func newFakeEngine() *fakeEngine {
	return &fakeEngine{
		audio:       make(chan engine.Frame),
		events:      make(chan engine.Event, 8),
		interrupted: make(chan time.Duration, 1),
	}
}

func (f *fakeEngine) PushAudio(context.Context, []byte) error { return nil }
func (f *fakeEngine) Commit(context.Context) error            { return nil }
func (f *fakeEngine) Audio() <-chan engine.Frame              { return f.audio }
func (f *fakeEngine) Events() <-chan engine.Event             { return f.events }
func (f *fakeEngine) Interrupt(_ context.Context, _ string, heard time.Duration) error {
	f.interrupted <- heard
	return nil
}
func (f *fakeEngine) Inject(context.Context, engine.ContextItem) error { return nil }
func (f *fakeEngine) Snapshot(context.Context) (engine.Snapshot, error) {
	return engine.Snapshot{}, nil
}
func (f *fakeEngine) Prefill(context.Context, engine.Snapshot) error { return nil }
func (f *fakeEngine) Stats() engine.Stats                            { return engine.Stats{} }
func (f *fakeEngine) Close() error                                   { return nil }

type fakeRoom struct {
	input     chan engine.Frame
	data      chan room.Data
	flushed   chan struct{}
	sent      chan room.Data
	published chan engine.Frame
}

func newFakeRoom() *fakeRoom {
	return &fakeRoom{
		input:     make(chan engine.Frame, 8),
		data:      make(chan room.Data, 8),
		flushed:   make(chan struct{}, 1),
		sent:      make(chan room.Data, 64),
		published: make(chan engine.Frame, 8),
	}
}

func (f *fakeRoom) Input() <-chan engine.Frame { return f.input }
func (f *fakeRoom) Data() <-chan room.Data     { return f.data }
func (f *fakeRoom) Publish(_ context.Context, frame engine.Frame) error {
	f.published <- frame
	return nil
}
func (f *fakeRoom) Send(_ context.Context, data room.Data) error {
	f.sent <- data
	return nil
}
func (f *fakeRoom) Flush(context.Context, string) error {
	f.flushed <- struct{}{}
	return nil
}
func (f *fakeRoom) Close() error { return nil }

type fakeBackend struct {
	events chan wire.Envelope
}

func (f *fakeBackend) Event(_ context.Context, event wire.Envelope) error {
	f.events <- event
	return nil
}
