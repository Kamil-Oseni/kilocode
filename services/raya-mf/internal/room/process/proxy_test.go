package process

import (
	"context"
	"errors"
	"io"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/room"
)

func proxy() *Proxy {
	return &Proxy{session: "client-rvs_adverse", rate: 24000, stop: make(chan struct{}), done: make(chan struct{}), ready: make(chan Message, 1), ack: make(chan Message, 1), jobs: make(chan Message), admit: make(chan struct{}, 1), input: make(chan engine.Frame, 64), data: make(chan room.Data, 64), failure: make(chan error, 1)}
}

func result(t *testing.T, values <-chan error) error {
	t.Helper()
	select {
	case err := <-values:
		return err
	case <-time.After(time.Second):
		t.Fatal("isolated operation exceeded bounded wait")
		return nil
	}
}

func TestProxyLostActionACKSealsWithoutReplay(t *testing.T) {
	p := proxy()
	p.id.Store(1)
	var writes atomic.Int32
	accepted := make(chan struct{})
	go func() { <-p.jobs; writes.Add(1); close(accepted) }()
	done := make(chan error, 1)
	go func() { done <- p.Publish(context.Background(), engine.Frame{Rate: 24000, PCM: make([]byte, 960)}) }()
	select {
	case <-accepted:
	case <-time.After(time.Second):
		t.Fatal("writer never accepted action")
	}
	if err := result(t, done); !errors.Is(err, ErrUnknown) || !p.stopped.Load() {
		t.Fatal("lost ACK was reported safe", err)
	}
	for range 3 {
		if err := p.Publish(context.Background(), engine.Frame{Rate: 24000, PCM: make([]byte, 960)}); !errors.Is(err, ErrStopped) {
			t.Fatal("sealed transport admitted another action", err)
		}
	}
	if writes.Load() != 1 {
		t.Fatal("unknown action replayed")
	}
	if !errors.Is(p.Err(), room.ErrCleanupUnknown) {
		t.Fatal("action timeout fabricated process termination")
	}
}

func TestProxyPrecancelledOrInvalidActionNeverReachesWriter(t *testing.T) {
	p := proxy()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := p.Publish(ctx, engine.Frame{Rate: 24000, PCM: make([]byte, 960)}); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if err := p.Send(context.Background(), room.Data{Topic: "test", Body: make([]byte, 15361)}); !errors.Is(err, ErrRefused) {
		t.Fatal(err)
	}
	if err := p.Publish(context.Background(), engine.Frame{Rate: 16000, PCM: make([]byte, 960)}); !errors.Is(err, ErrRefused) {
		t.Fatal(err)
	}
	if p.stopped.Load() || p.pending.Load() != 0 {
		t.Fatal("unadmitted refusal changed native ownership")
	}
}

func TestProxyExactACKPreservesMaximumControlAndFrameProvenance(t *testing.T) {
	p := proxy()
	p.id.Store(1)
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	ended := make(chan struct{})
	go func() { defer close(ended); p.read(reader) }()
	if err := Write(writer, Message{Version: Version, Session: p.session, ID: 1, Op: "ready", Outcome: "confirmed"}); err != nil {
		t.Fatal(err)
	}
	<-p.ready
	observed := make(chan Message, 2)
	go func() {
		for range 2 {
			message := <-p.jobs
			observed <- message
			_ = Write(writer, Message{Version: Version, Session: p.session, ID: message.ID, Op: "ack", Outcome: "confirmed"})
		}
	}()
	body := []byte(strings.Repeat("x", 15360))
	if err := p.Send(context.Background(), room.Data{Topic: "raya.transcript", Body: body}); err != nil {
		t.Fatal(err)
	}
	frame := engine.Frame{Turn: "turn", Item: "item", Epoch: 2, Seq: 7, Start: 10, End: 490, Final: true, At: time.Now().UTC(), Rate: 24000, PCM: make([]byte, 960)}
	if err := p.Publish(context.Background(), frame); err != nil {
		t.Fatal(err)
	}
	first, second := <-observed, <-observed
	body[0] = 'y'
	frame.PCM[0] = 3
	if len(first.Data.Body) != 15360 || first.Data.Body[0] != 'x' || second.Frame.PCM[0] != 0 || second.Frame.Turn != frame.Turn || second.Frame.Item != frame.Item || second.Frame.Epoch != frame.Epoch || second.Frame.Seq != frame.Seq || second.Frame.Start != frame.Start || second.Frame.End != frame.End || !second.Frame.Final || !second.Frame.At.Equal(frame.At) {
		t.Fatal("IPC altered owned payload or provenance")
	}
	p.halt()
	_ = writer.Close()
	select {
	case <-ended:
	case <-time.After(time.Second):
		t.Fatal("test reader did not end")
	}
}

func TestProxyWrongSessionOrACKCannotConfirmAction(t *testing.T) {
	for _, mode := range []string{"session", "id", "event"} {
		t.Run(mode, func(t *testing.T) {
			p := proxy()
			p.pending.Store(2)
			reader, writer := io.Pipe()
			defer reader.Close()
			defer writer.Close()
			ended := make(chan struct{})
			go func() { defer close(ended); p.read(reader) }()
			_ = Write(writer, Message{Version: Version, Session: p.session, ID: 1, Op: "ready", Outcome: "confirmed"})
			message := Message{Version: Version, Session: p.session, ID: 3, Op: "ack", Outcome: "confirmed"}
			if mode == "session" {
				message.Session = "client-rvs_foreign"
			}
			if mode == "event" {
				message = Message{Version: Version, Session: p.session, Op: "data", Data: &room.Data{Identity: "client-rvs_foreign", Topic: "raya.playout", Body: []byte("private")}}
			}
			if err := Write(writer, message); err != nil {
				t.Fatal(err)
			}
			select {
			case <-ended:
			case <-time.After(time.Second):
				t.Fatal("wrong target did not seal reader")
			}
			if !p.stopped.Load() || len(p.ack) != 0 || len(p.data) != 0 {
				t.Fatal("changed target was accepted")
			}
		})
	}
}

func TestProxyDuplicateACKIsClaimedOnlyOnce(t *testing.T) {
	p := proxy()
	p.pending.Store(2)
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	ended := make(chan struct{})
	go func() { defer close(ended); p.read(reader) }()
	_ = Write(writer, Message{Version: Version, Session: p.session, ID: 1, Op: "ready", Outcome: "confirmed"})
	ack := Message{Version: Version, Session: p.session, ID: 2, Op: "ack", Outcome: "confirmed"}
	if err := Write(writer, ack); err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.ack:
	case <-time.After(time.Second):
		t.Fatal("first exact ACK was lost")
	}
	if err := Write(writer, ack); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ended:
	case <-time.After(time.Second):
		t.Fatal("duplicate ACK did not seal")
	}
	if !p.stopped.Load() || len(p.ack) != 0 || p.pending.Load() != 0 {
		t.Fatal("duplicate ACK retained authority to confirm later work")
	}
}

func TestProxyStaleBufferedACKCannotConfirmNewOperation(t *testing.T) {
	p := proxy()
	p.id.Store(2)
	p.ack <- Message{Version: Version, Session: p.session, ID: 2, Op: "ack", Outcome: "confirmed"}
	accepted := make(chan Message, 1)
	go func() { accepted <- <-p.jobs }()
	if err := p.Publish(context.Background(), engine.Frame{Rate: 24000, PCM: make([]byte, 960)}); !errors.Is(err, ErrUnknown) {
		t.Fatal("stale receipt confirmed a new action", err)
	}
	message := <-accepted
	if message.ID != 3 || !p.stopped.Load() {
		t.Fatal("new operation was not fenced after mismatched receipt")
	}
}

func TestProxyOverlappingAudioAndTranscriptWaitForExactOwner(t *testing.T) {
	p := proxy()
	p.id.Store(1)
	first := make(chan Message, 1)
	release := make(chan struct{})
	second := make(chan Message, 1)
	go func() {
		message := <-p.jobs
		first <- message
		<-release
		p.ack <- Message{ID: message.ID, Outcome: "confirmed"}
		message = <-p.jobs
		second <- message
		p.ack <- Message{ID: message.ID, Outcome: "confirmed"}
	}()
	results := make(chan error, 2)
	go func() { results <- p.Publish(context.Background(), engine.Frame{Rate: 24000, PCM: make([]byte, 960)}) }()
	audio := <-first
	go func() {
		results <- p.Send(context.Background(), room.Data{Topic: "raya.transcript", Body: []byte("caption")})
	}()
	deadline := time.Now().Add(10 * time.Millisecond)
	for p.queued.Load() != 2 && time.Now().Before(deadline) {
		time.Sleep(100 * time.Microsecond)
	}
	if p.queued.Load() != 2 {
		close(release)
		t.Fatal("ordinary concurrent lane refused instead of waiting")
	}
	close(release)
	for range 2 {
		if err := result(t, results); err != nil {
			t.Fatal(err)
		}
	}
	caption := <-second
	if audio.Op != "publish" || caption.Op != "send" || caption.ID <= audio.ID || p.stopped.Load() || p.queued.Load() != 0 {
		t.Fatal("bounded serialization changed action identity or sealed valid overlap")
	}
}
