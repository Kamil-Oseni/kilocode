// raya_change - Barge-in and playout-accounting conformance for Raya's media session.
package app

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
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
	session := NewSession(context.Background(), "test", voice, media, backend, "client-test")
	defer session.Close()

	voice.events <- engine.Event{Type: "response.created", Turn: "response"}
	<-backend.events
	published(t, session, media, "assistant-1", 25)
	reported(t, session, wire.Playout{Version: 2, Session: "test", Item: "assistant-1", Epoch: 1, Seq: 25, Samples: 12000, Rate: 24000})
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

	for index, item := range []string{"assistant-1", "assistant-2"} {
		voice.audio <- engine.Frame{Item: item, PCM: make([]byte, 960), Rate: 24000, Epoch: 1, Seq: uint64(index + 1), End: 480}
		select {
		case data := <-media.sent:
			if data.Topic != "raya.playout.item" {
				t.Fatalf("topic = %q", data.Topic)
			}
			var got wire.Span
			if err := json.Unmarshal(data.Body, &got); err != nil || got.Item != item || got.Version != 2 || got.Session != "playout" || got.Seq != uint64(index+1) || got.Start != 0 || got.End != 480 {
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

func published(t *testing.T, session *Session, media *fakeRoom, item string, count int) {
	t.Helper()
	for index := range count {
		if !session.publish(engine.Frame{Item: item, PCM: make([]byte, 960), Rate: 24000, Epoch: 1, Seq: uint64(index + 1), Start: uint64(index * 480), End: uint64((index + 1) * 480)}) {
			t.Fatal("valid frame was refused")
		}
		<-media.sent
		<-media.published
	}
}

func reported(t *testing.T, session *Session, value wire.Playout) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	session.report(room.Data{Topic: "raya.playout", Body: raw, Identity: session.client})
	if !session.proof {
		t.Fatal("exact client receipt was refused")
	}
}

func TestPlayoutReceiptRequiresExactPublishedClientSpan(t *testing.T) {
	for _, change := range []string{"identity", "legacy", "session", "item", "epoch", "sequence", "before", "after", "rate", "jitter", "unknown", "trailing"} {
		t.Run(change, func(t *testing.T) {
			media := newFakeRoom()
			s := NewSession(context.Background(), "receipt", newFakeEngine(), media, nil, "client-receipt")
			defer s.Close()
			published(t, s, media, "assistant", 2)
			value := wire.Playout{Version: 2, Session: "receipt", Item: "assistant", Epoch: 1, Seq: 2, Samples: 720, Rate: 24000}
			identity := "client-receipt"
			switch change {
			case "identity":
				identity = "another-client"
			case "legacy":
				value.Version = 0
			case "session":
				value.Session = "another-session"
			case "item":
				value.Item = "another-item"
			case "epoch":
				value.Epoch = 2
			case "sequence":
				value.Seq = 3
			case "before":
				value.Samples = 479
			case "after":
				value.Samples = 961
			case "rate":
				value.Rate = 48000
			case "jitter":
				value.Jitter = -1
			}
			raw, _ := json.Marshal(value)
			if change == "unknown" {
				raw = append(raw[:len(raw)-1], []byte(`,"trusted":true}`)...)
			}
			if change == "trailing" {
				raw = append(raw, []byte(` {}`)...)
			}
			s.report(room.Data{Identity: identity, Body: raw})
			if s.proof {
				t.Fatal("untrusted or mismatched receipt became heard evidence")
			}
		})
	}
}

func TestBargeFencesBufferedAudioAndOldReceipts(t *testing.T) {
	media := newFakeRoom()
	voice := newFakeEngine()
	s := NewSession(context.Background(), "fence", voice, media, nil, "client-fence")
	defer s.Close()
	published(t, s, media, "assistant", 2)
	value := wire.Playout{Version: 2, Session: "fence", Item: "assistant", Epoch: 1, Seq: 2, Samples: 720, Rate: 24000}
	reported(t, s, value)
	s.barge()
	if heard := <-voice.interrupted; heard != 30*time.Millisecond {
		t.Fatalf("heard = %s", heard)
	}
	<-media.sent // discontinuity
	if !s.publish(engine.Frame{Item: "assistant", PCM: make([]byte, 960), Rate: 24000, Epoch: 1, Seq: 3, Start: 960, End: 1440}) {
		t.Fatal("stale frame should be discarded without failing")
	}
	select {
	case <-media.published:
		t.Fatal("old epoch escaped the interruption fence")
	default:
	}
	raw, _ := json.Marshal(value)
	s.report(room.Data{Identity: "client-fence", Body: raw})
	if s.proof {
		t.Fatal("old receipt crossed interruption fence")
	}
	if !s.publish(engine.Frame{Item: "next", PCM: make([]byte, 960), Rate: 24000, Epoch: 2, Seq: 4, End: 480}) {
		t.Fatal("next epoch should remain usable")
	}
	<-media.sent
	<-media.published
}

func TestProviderCompletionDoesNotProvePlayback(t *testing.T) {
	media := newFakeRoom()
	voice := newFakeEngine()
	backend := &fakeBackend{events: make(chan wire.Envelope, 8)}
	s := NewSession(context.Background(), "done", voice, media, backend, "client-done")
	defer s.Close()
	voice.events <- engine.Event{Type: "response.created", Turn: "response"}
	<-backend.events
	voice.events <- engine.Event{Type: "response.done", Turn: "other"}
	<-backend.events
	if !s.generating.Load() {
		t.Fatal("another response completion cleared current generation")
	}
	voice.events <- engine.Event{Type: "response.done", Turn: "response"}
	<-backend.events
	if !s.speaking.Load() {
		t.Fatal("provider completion before first clock frame falsely settled playback")
	}
	published(t, s, media, "assistant", 1)
	if !s.speaking.Load() || s.proof {
		t.Fatal("provider completion was confused with heard playback")
	}
	reported(t, s, wire.Playout{Version: 2, Session: "done", Item: "assistant", Epoch: 1, Seq: 1, Samples: 480, Rate: 24000})
	if !s.speaking.Load() {
		t.Fatal("current span receipt fabricated a sealed final audio boundary")
	}
	if !s.publish(engine.Frame{Item: "assistant", PCM: make([]byte, 960), Rate: 24000, Epoch: 1, Seq: 2, Start: 480, End: 960}) {
		t.Fatal("queued tail frame was refused")
	}
	<-media.sent
	<-media.published
	s.barge()
	if heard := <-voice.interrupted; heard != 20*time.Millisecond {
		t.Fatalf("queued tail changed confirmed heard cursor: %s", heard)
	}
}

func TestHeardDurationRejectsOverflow(t *testing.T) {
	for _, value := range []wire.Playout{{Samples: math.MaxUint64, Rate: 8000}, {Samples: 1, Rate: 0}, {Samples: 1, Rate: math.MaxInt}} {
		if _, valid := duration(value); valid {
			t.Fatalf("invalid duration accepted: %#v", value)
		}
	}
}

func TestSilenceTicksDoNotSendPlayoutEvidence(t *testing.T) {
	media := newFakeRoom()
	s := NewSession(context.Background(), "silence", newFakeEngine(), media, nil)
	defer s.Close()
	if !s.publish(engine.Frame{PCM: make([]byte, 960), Rate: 24000, Epoch: 1, Seq: 1}) {
		t.Fatal("silence tick was refused")
	}
	<-media.published
	select {
	case <-media.sent:
		t.Fatal("idle silence produced reliable playout metadata")
	default:
	}
	if len(s.spans) != 0 || s.proof || s.speaking.Load() {
		t.Fatal("silence became heard evidence")
	}
}

func TestPlayoutReceiptsCannotRewindOrCrossItems(t *testing.T) {
	media := newFakeRoom()
	s := NewSession(context.Background(), "monotone", newFakeEngine(), media, nil, "client-monotone")
	defer s.Close()
	published(t, s, media, "first", 2)
	value := wire.Playout{Version: 2, Session: "monotone", Item: "first", Epoch: 1, Seq: 2, Samples: 800, Rate: 24000}
	reported(t, s, value)
	older := value
	older.Samples = 720
	raw, _ := json.Marshal(older)
	s.report(room.Data{Identity: s.client, Body: raw})
	if s.heard != value {
		t.Fatal("receipt rewound heard cursor")
	}
	if !s.publish(engine.Frame{Item: "second", PCM: make([]byte, 960), Rate: 24000, Epoch: 1, Seq: 3, End: 480}) {
		t.Fatal("new item publication failed")
	}
	<-media.sent
	<-media.published
	raw, _ = json.Marshal(value)
	s.report(room.Data{Identity: s.client, Body: raw})
	if s.proof {
		t.Fatal("old item receipt proved new item playback")
	}
}

func TestDiscontinuousPublishedSamplesFailClosed(t *testing.T) {
	for _, change := range []string{"gap", "rate", "sequence", "epoch"} {
		t.Run(change, func(t *testing.T) {
			media := newFakeRoom()
			s := NewSession(context.Background(), "gap", newFakeEngine(), media, nil)
			defer s.Close()
			published(t, s, media, "assistant", 1)
			frame := engine.Frame{Item: "assistant", PCM: make([]byte, 960), Rate: 24000, Epoch: 1, Seq: 2, Start: 480, End: 960}
			switch change {
			case "gap":
				frame.Start, frame.End = 960, 1440
			case "rate":
				frame.Rate, frame.PCM = 48000, make([]byte, 1920)
			case "sequence":
				frame.Seq = 1
			case "epoch":
				frame.Epoch = 0
			}
			if s.publish(frame) {
				t.Fatal("inconsistent frame accepted")
			}
			status := finished(t, s)
			if status.Failure == nil || status.Failure.Code != "playout_metadata" {
				t.Fatalf("failure = %#v", status.Failure)
			}
		})
	}
}

func TestOngoingUserSpeechInterruptsNewAssistantAudio(t *testing.T) {
	voice := newFakeEngine()
	media := newFakeRoom()
	s := NewSession(context.Background(), "ongoing", voice, media, nil, "client-ongoing")
	defer s.Close()
	pcm := make([]byte, 640)
	for index := 0; index < len(pcm); index += 2 {
		pcm[index], pcm[index+1] = 0xff, 0x3f
	}
	media.input <- engine.Frame{PCM: pcm, Rate: 16000}
	select {
	case <-voice.pushed:
	case <-time.After(time.Second):
		t.Fatal("initial user speech was not processed")
	}
	published(t, s, media, "assistant", 1)
	reported(t, s, wire.Playout{Version: 2, Session: "ongoing", Item: "assistant", Epoch: 1, Seq: 1, Samples: 240, Rate: 24000})
	// Confirmed partial playback still needs interruption.
	media.input <- engine.Frame{PCM: pcm, Rate: 16000}
	select {
	case heard := <-voice.interrupted:
		if heard != 10*time.Millisecond {
			t.Fatalf("heard = %s", heard)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("ongoing speech did not interrupt newly started assistant audio")
	}
	<-voice.pushed
	media.input <- engine.Frame{PCM: pcm, Rate: 16000}
	<-voice.pushed
	select {
	case <-voice.interrupted:
		t.Fatal("continuous user speech repeated the same interruption")
	default:
	}
}

type blockedRoom struct {
	*fakeRoom
	entered chan struct{}
	release chan struct{}
}

func TestSealedSourceBoundaryRequiresExactFinalClientReceipt(t *testing.T) {
	for _, change := range []string{"exact", "receipt-first", "turn", "seq", "end", "epoch", "version", "unsealed", "new-turn"} {
		t.Run(change, func(t *testing.T) {
			media := newFakeRoom()
			voice := newFakeEngine()
			backend := &fakeBackend{events: make(chan wire.Envelope, 8)}
			s := NewSession(context.Background(), "sealed", voice, media, backend, "client-sealed")
			defer s.Close()
			voice.events <- engine.Event{Type: "response.created", Turn: "response"}
			<-backend.events
			frame := engine.Frame{Item: "assistant", Turn: "response", PCM: make([]byte, 960), Rate: 24000, Epoch: 1, Seq: 1, End: 480}
			if !s.publish(frame) {
				t.Fatal("source PCM was refused")
			}
			<-media.sent
			<-media.published
			frame.Seq, frame.Start, frame.Final = 2, 480, change != "unsealed"
			if change == "unsealed" {
				frame.End = 960
			}
			if !s.publish(frame) {
				t.Fatal("source terminal boundary was refused")
			}
			packet := <-media.sent
			var span wire.Span
			if err := json.Unmarshal(packet.Body, &span); err != nil || span.Version != 3 || span.Turn != "response" || span.Final != frame.Final || span.Seq != 2 || span.End != frame.End {
				t.Fatalf("terminal span = %#v / %v", span, err)
			}
			<-media.published
			if change != "receipt-first" {
				voice.events <- engine.Event{Type: "response.done", Turn: "response"}
				<-backend.events
			}
			if !s.speaking.Load() {
				t.Fatal("source seal alone proved client playback")
			}
			value := wire.Playout{Version: 3, Session: "sealed", Item: "assistant", Turn: "response", Final: true, Epoch: 1, Seq: 2, Samples: 480, Rate: 24000}
			switch change {
			case "turn":
				value.Turn = "other"
			case "seq":
				value.Seq = 1
			case "end":
				value.Samples = 479
			case "epoch":
				value.Epoch = 2
			case "version":
				value.Version = 2
			case "unsealed":
				value.Samples = 960
			case "new-turn":
				voice.events <- engine.Event{Type: "response.created", Turn: "next"}
				<-backend.events
			}
			raw, _ := json.Marshal(value)
			s.report(room.Data{Identity: "client-sealed", Body: raw})
			if change == "receipt-first" {
				if !s.speaking.Load() {
					t.Fatal("receipt settled a still-generating response")
				}
				voice.events <- engine.Event{Type: "response.done", Turn: "response"}
				<-backend.events
			}
			settled := change == "exact" || change == "receipt-first"
			if s.speaking.Load() == settled {
				t.Fatalf("settled=%v speaking=%v", settled, s.speaking.Load())
			}
		})
	}
}

func TestTerminalBoundaryCannotInventPriorPCM(t *testing.T) {
	media := newFakeRoom()
	s := NewSession(context.Background(), "unknown", newFakeEngine(), media, nil)
	defer s.Close()
	if s.publish(engine.Frame{Item: "unknown", Turn: "response", Final: true, PCM: make([]byte, 960), Rate: 24000, Epoch: 1, Seq: 1}) {
		t.Fatal("terminal marker without known PCM was accepted")
	}
	if status := finished(t, s); status.Failure == nil || status.Failure.Code != "playout_metadata" {
		t.Fatalf("status = %#v", status)
	}
}

func TestExplicitEmptyResponseCannotSettleUnknownOrNewOutput(t *testing.T) {
	for _, kind := range []string{"fresh", "unknown", "confirmed", "stale", "absent", "false"} {
		t.Run(kind, func(t *testing.T) {
			media := newFakeRoom()
			voice := newFakeEngine()
			backend := &fakeBackend{events: make(chan wire.Envelope, 8)}
			s := NewSession(context.Background(), "empty", voice, media, backend, "client-empty")
			defer s.Close()
			if kind == "unknown" || kind == "confirmed" {
				if !s.publish(engine.Frame{Item: "prior", Turn: "prior-response", Final: true, PCM: make([]byte, 960), Rate: 24000, Epoch: 1, Seq: 1, End: 480}) {
					t.Fatal("prior final PCM refused")
				}
				<-media.sent
				<-media.published
				if kind == "confirmed" {
					reported(t, s, wire.Playout{Version: 3, Session: "empty", Item: "prior", Turn: "prior-response", Final: true, Epoch: 1, Seq: 1, Samples: 480, Rate: 24000})
				}
			}
			voice.events <- engine.Event{Type: "response.created", Turn: "empty-response"}
			<-backend.events
			turn := "empty-response"
			if kind == "stale" {
				voice.events <- engine.Event{Type: "response.created", Turn: "next"}
				<-backend.events
			}
			data := map[string]any{"audioEmpty": true}
			if kind == "absent" {
				data = nil
			}
			if kind == "false" {
				data["audioEmpty"] = false
			}
			voice.events <- engine.Event{Type: "response.done", Turn: turn, Data: data}
			<-backend.events
			settled := kind == "fresh" || kind == "confirmed"
			if s.speaking.Load() == settled {
				t.Fatalf("%s settled=%v speaking=%v", kind, settled, s.speaking.Load())
			}
		})
	}
}

func TestContinuousNativeSessionForwardsSpeechAndSilenceWithoutManualTurns(t *testing.T) {
	voice := newFakeEngine()
	media := newFakeRoom()
	cfg := engine.Descriptor{ID: "openai-live", NativeBargeIn: true, RequiresContinuousInput: true, InputRate: 24000, OutputRate: 24000}
	s := NewSessionWithDescriptor(context.Background(), "continuous", voice, media, nil, "client-continuous", cfg)
	defer s.Close()
	cfg.InputRate = 16000 // The running contract is a value captured before workers start.
	if !s.publish(engine.Frame{Item: "local-stream", PCM: make([]byte, 960), Rate: 24000, Epoch: 1, Seq: 1, End: 480}) {
		t.Fatal("local continuous source PCM refused")
	}
	packet := <-media.sent
	<-media.published
	var span wire.Span
	if err := json.Unmarshal(packet.Body, &span); err != nil || span.Version != 2 || span.Turn != "" || span.Final {
		t.Fatalf("continuous output invented a provider boundary: %#v / %v", span, err)
	}
	for _, spoken := range []bool{false, true, false} {
		pcm := make([]byte, 960)
		if spoken {
			for index := 0; index < len(pcm); index += 2 {
				pcm[index], pcm[index+1] = 0xff, 0x3f
			}
		}
		media.input <- engine.Frame{PCM: pcm, Rate: 24000}
		select {
		case received := <-voice.received:
			if !bytes.Equal(received, pcm) {
				t.Fatal("continuous input bytes changed")
			}
		case <-time.After(time.Second):
			t.Fatal("continuous silence or speech was not forwarded")
		}
	}
	select {
	case <-voice.interrupted:
		t.Fatal("native continuous input invented a manual provider interruption")
	case <-voice.committed:
		t.Fatal("native continuous input invented a manual turn commit")
	case <-media.flushed:
		t.Fatal("native continuous input invented a client playout boundary")
	default:
	}
	if s.Status().State != "active" {
		t.Fatal("native speech was failed for missing manual heard evidence")
	}
}

func TestContinuousInputRefusesWrongRateAndFrameSize(t *testing.T) {
	for _, frame := range []engine.Frame{{Rate: 16000, PCM: make([]byte, 960)}, {Rate: 24000, PCM: make([]byte, 640)}, {Rate: 24000, PCM: make([]byte, 958)}, {Rate: 24000, PCM: make([]byte, 1920)}} {
		voice := newFakeEngine()
		media := newFakeRoom()
		s := NewSessionWithDescriptor(context.Background(), "format", voice, media, nil, "client-format", engine.Descriptor{ID: "openai-live", NativeBargeIn: true, RequiresContinuousInput: true, InputRate: 24000, OutputRate: 24000})
		media.input <- frame
		status := finished(t, s)
		if status.Failure == nil || status.Failure.Code != "audio_input" {
			t.Fatalf("status = %#v", status)
		}
		select {
		case <-voice.received:
			t.Fatal("malformed continuous PCM reached provider")
		default:
		}
		s.Close()
	}
}

func TestContinuousHelperRefusesUnsupportedProviderContract(t *testing.T) {
	for _, cfg := range []engine.Descriptor{{ID: "qwen-realtime", NativeBargeIn: true, RequiresContinuousInput: true, InputRate: 16000, OutputRate: 24000}, {ID: "openai-live", InputRate: 24000, OutputRate: 24000}, {ID: "openai-live", NativeBargeIn: true, RequiresContinuousInput: true, InputRate: 16000, OutputRate: 24000}} {
		s := NewSessionWithDescriptor(context.Background(), "unsupported", newFakeEngine(), newFakeRoom(), nil, "client-unsupported", cfg)
		status := finished(t, s)
		if status.Failure == nil || status.Failure.Code != "audio_input" {
			t.Fatalf("unsupported contract = %#v", status)
		}
		s.Close()
	}
}

func TestContinuousOutputCannotRelabelDifferentSampleRate(t *testing.T) {
	media := newFakeRoom()
	s := NewSessionWithDescriptor(context.Background(), "output-rate", newFakeEngine(), media, nil, "client-output-rate", engine.Descriptor{ID: "openai-live", NativeBargeIn: true, RequiresContinuousInput: true, InputRate: 24000, OutputRate: 24000})
	defer s.Close()
	if s.publish(engine.Frame{Item: "local-stream", PCM: make([]byte, 1920), Rate: 48000, Epoch: 1, Seq: 1, End: 960}) {
		t.Fatal("different output sample rate was relabeled as continuous24k")
	}
	status := finished(t, s)
	if status.Failure == nil || status.Failure.Code != "playout_metadata" {
		t.Fatalf("status = %#v", status)
	}
	select {
	case <-media.published:
		t.Fatal("mismatched output PCM was published")
	default:
	}
}

func (f *blockedRoom) Flush(ctx context.Context, item string) error {
	close(f.entered)
	select {
	case <-f.release:
		return f.fakeRoom.Flush(ctx, item)
	case <-ctx.Done():
		return ctx.Err()
	}
}

func TestBargeBeforeFirstFrameBlocksPublicationDuringFlush(t *testing.T) {
	media := &blockedRoom{fakeRoom: newFakeRoom(), entered: make(chan struct{}), release: make(chan struct{})}
	voice := newFakeEngine()
	s := NewSession(context.Background(), "before", voice, media, nil, "client-before")
	defer s.Close()
	done := make(chan struct{})
	go func() { s.barge(); close(done) }()
	<-media.entered
	if !s.publish(engine.Frame{Item: "first", PCM: make([]byte, 960), Rate: 24000, Epoch: 1, Seq: 1, End: 480}) {
		t.Fatal("stopped frame should be discarded without another failure")
	}
	select {
	case <-media.published:
		t.Fatal("first frame escaped while unconfirmed flush was blocked")
	default:
	}
	close(media.release)
	<-done
	status := finished(t, s)
	if status.Failure == nil || status.Failure.Code != "playout_unconfirmed" {
		t.Fatalf("failure = %#v", status.Failure)
	}
	select {
	case <-voice.interrupted:
		t.Fatal("missing playback proof invented provider truncation")
	default:
	}
}

type fakeEngine struct {
	audio       chan engine.Frame
	events      chan engine.Event
	interrupted chan time.Duration
	pushed      chan struct{}
	received    chan []byte
	committed   chan struct{}
}

func newFakeEngine() *fakeEngine {
	return &fakeEngine{
		audio:       make(chan engine.Frame),
		events:      make(chan engine.Event, 8),
		interrupted: make(chan time.Duration, 1),
		pushed:      make(chan struct{}, 64),
		received:    make(chan []byte, 64),
		committed:   make(chan struct{}, 8),
	}
}

func (f *fakeEngine) PushAudio(_ context.Context, pcm []byte) error {
	f.received <- append([]byte(nil), pcm...)
	f.pushed <- struct{}{}
	return nil
}
func (f *fakeEngine) Commit(context.Context) error { f.committed <- struct{}{}; return nil }
func (f *fakeEngine) Audio() <-chan engine.Frame   { return f.audio }
func (f *fakeEngine) Events() <-chan engine.Event  { return f.events }
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
