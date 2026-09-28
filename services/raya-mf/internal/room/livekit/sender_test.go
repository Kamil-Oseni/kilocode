// raya_change - Actual owned RTP sender with controlled synchronous sinks.
package livekit

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

func owned(t *testing.T, write func(*rtp.Packet) error) *sender {
	t.Helper()
	s, err := newSender(write)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	return s
}

func TestSenderDirectWritesAdvanceExactOpusClock(t *testing.T) {
	var packets []*rtp.Packet
	s := owned(t, func(frame *rtp.Packet) error {
		packets = append(packets, frame.Clone())
		return nil
	})
	for range 4 {
		if err := s.Send(context.Background(), []byte{0xf8, 0xff, 0xfe}); err != nil {
			t.Fatal(err)
		}
	}
	if len(packets) != 4 || s.Idle() != nil {
		t.Fatal("direct writes were queued or remained active")
	}
	for index, frame := range packets {
		if frame.Version != 2 || !bytes.Equal(frame.Payload, []byte{0xf8, 0xff, 0xfe}) {
			t.Fatal("direct RTP packet changed payload or framing")
		}
		if index > 0 && (frame.SequenceNumber != packets[index-1].SequenceNumber+1 || frame.Timestamp != packets[index-1].Timestamp+960) {
			t.Fatal("20 ms Opus RTP clock did not advance exactly once")
		}
	}
	count := len(packets)
	if err := s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := s.Send(context.Background(), []byte{1}); !errors.Is(err, errStopped) || len(packets) != count || !errors.Is(s.Idle(), errStopped) {
		t.Fatal("closed sender retained a future send path")
	}
}

func TestSenderRefusesInvalidAndCancelledPacketsBeforeWrite(t *testing.T) {
	var count atomic.Int32
	s := owned(t, func(*rtp.Packet) error { count.Add(1); return nil })
	for _, data := range [][]byte{nil, {}, make([]byte, payload+1)} {
		if err := s.Send(context.Background(), data); err == nil {
			t.Fatal("invalid Opus packet was accepted")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.Send(ctx, []byte{1}); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled packet did not preserve cancellation")
	}
	if count.Load() != 0 || s.Idle() != nil {
		t.Fatal("refused packet reached writer or poisoned idle ownership")
	}
	if err := s.Send(context.Background(), make([]byte, payload)); err != nil || count.Load() != 1 {
		t.Fatal("maximum bounded Opus packet was refused")
	}
	if _, err := newSender(nil); err == nil {
		t.Fatal("nil writer was accepted")
	}
}

func TestSenderBlockedWriterOwnsOneCopyAndNeverPromisesDrain(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	var writes atomic.Int32
	var got []byte
	s := owned(t, func(frame *rtp.Packet) error {
		writes.Add(1)
		close(entered)
		<-release
		got = append([]byte(nil), frame.Payload...)
		return nil
	})
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	data := []byte{1, 2, 3}
	result := make(chan error, 1)
	go func() { result <- s.Send(context.Background(), data) }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("writer did not receive owned packet")
	}
	clear(data)
	if !errors.Is(s.Idle(), errBusy) || !errors.Is(s.Send(context.Background(), []byte{4}), errBusy) {
		t.Fatal("second write bypassed single-flight ownership")
	}
	select {
	case err := <-result:
		if !errors.Is(err, errUnknown) || !errors.Is(err, context.DeadlineExceeded) {
			t.Fatal("blocked write fabricated a definite send result")
		}
	case <-time.After(time.Second):
		t.Fatal("blocked writer defeated bounded send deadline")
	}
	if err := s.Close(context.Background()); !errors.Is(err, errUnknown) {
		t.Fatal("close claimed termination before writer returned")
	}
	for range 20 {
		if !errors.Is(s.Send(context.Background(), []byte{4}), errStopped) {
			t.Fatal("uncertain write spawned another writer")
		}
	}
	once.Do(func() { close(release) })
	if err := s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if writes.Load() != 1 || !bytes.Equal(got, []byte{1, 2, 3}) {
		t.Fatal("writer owner/copy was lost across cancellation")
	}
}

func TestSenderExplicitCancellationDuringWriteSealsFutureTraffic(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	s := owned(t, func(*rtp.Packet) error { close(entered); <-release; return nil })
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- s.Send(ctx, []byte{1}) }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("writer did not receive packet before cancellation")
	}
	cancel()
	if err := <-result; !errors.Is(err, errUnknown) || !errors.Is(err, context.Canceled) {
		t.Fatal("in-flight cancellation was treated as definitely unsent")
	}
	once.Do(func() { close(release) })
	if err := s.Close(context.Background()); err != nil || !errors.Is(s.Idle(), errStopped) {
		t.Fatal("cancelled sender revived or failed to terminate")
	}
}

func TestSenderWriterFailureNeverReplays(t *testing.T) {
	var count atomic.Int32
	cause := errors.New("sink rejected after possible write")
	s := owned(t, func(*rtp.Packet) error { count.Add(1); return cause })
	if err := s.Send(context.Background(), []byte{1}); !errors.Is(err, errUnknown) {
		t.Fatal("external write error was treated as definitely unsent")
	}
	if err := s.Send(context.Background(), []byte{1}); !errors.Is(err, errStopped) || count.Load() != 1 {
		t.Fatal("failed write was replayed")
	}
}

func TestSenderCloseBeforeAdmissionHasNoSinkSideEffect(t *testing.T) {
	var count atomic.Int32
	s := owned(t, func(*rtp.Packet) error { count.Add(1); return nil })
	if err := s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := s.Send(context.Background(), []byte{1}); !errors.Is(err, errStopped) || count.Load() != 0 {
		t.Fatal("closed-before-admission packet reached the sink")
	}
}

func TestSenderCloseAndSendRaceNeverWritesAfterConfirmedTermination(t *testing.T) {
	for range 32 {
		var count atomic.Int32
		s := owned(t, func(*rtp.Packet) error { count.Add(1); return nil })
		start := make(chan struct{})
		sent := make(chan error, 1)
		closed := make(chan error, 1)
		go func() { <-start; sent <- s.Send(context.Background(), []byte{1}) }()
		go func() { <-start; closed <- s.Close(context.Background()) }()
		close(start)
		if err := <-closed; err != nil {
			t.Fatal(err)
		}
		err := <-sent
		if err != nil && !errors.Is(err, errStopped) && !errors.Is(err, errUnknown) {
			t.Fatal("close/send race produced an uncorrelated failure")
		}
		before := count.Load()
		if before > 1 || !errors.Is(s.Send(context.Background(), []byte{2}), errStopped) || count.Load() != before {
			t.Fatal("confirmed sender termination allowed another write")
		}
		select {
		case <-s.end:
		default:
			t.Fatal("Close returned before writer terminated")
		}
	}
}

// probe supplies a synchronous byte sink to the real pinned Pion track.
// It is not a WebRTC network/decoder/render or acoustic acceptance fixture.
type probe struct{ sink *wire }

func (probe) CodecParameters() []webrtc.RTPCodecParameters {
	return []webrtc.RTPCodecParameters{{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 1}, PayloadType: 109}}
}
func (probe) HeaderExtensions() []webrtc.RTPHeaderExtensionParameter { return nil }
func (probe) SSRC() webrtc.SSRC                                      { return 123 }
func (probe) SSRCRetransmission() webrtc.SSRC                        { return 0 }
func (probe) SSRCForwardErrorCorrection() webrtc.SSRC                { return 0 }
func (b probe) WriteStream() webrtc.TrackLocalWriter                 { return b.sink }
func (probe) ID() string                                             { return "synthetic-sink" }
func (probe) RTCPReader() interceptor.RTCPReader                     { return nil }

type wire struct{ data [][]byte }

func (w *wire) WriteRTP(header *rtp.Header, data []byte) (int, error) {
	frame := rtp.Packet{Header: *header, Payload: data}
	encoded, err := frame.Marshal()
	if err != nil {
		return 0, err
	}
	return w.Write(encoded)
}
func (w *wire) Write(data []byte) (int, error) {
	w.data = append(w.data, append([]byte(nil), data...))
	return len(data), nil
}

func TestSenderUsesRealPionTrackBindingAndWireEncoding(t *testing.T) {
	track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 1}, "voice", "raya")
	if err != nil {
		t.Fatal(err)
	}
	sink := &wire{}
	ctx := probe{sink: sink}
	if _, err := track.Bind(ctx); err != nil {
		t.Fatal(err)
	}
	s := owned(t, track.WriteRTP)
	for range 2 {
		if err := s.Send(context.Background(), []byte{0xf8, 0xff, 0xfe}); err != nil {
			t.Fatal(err)
		}
	}
	if len(sink.data) != 2 {
		t.Fatal("Pion did not synchronously publish both RTP packets")
	}
	var prior rtp.Packet
	for index, data := range sink.data {
		var frame rtp.Packet
		if err := frame.Unmarshal(data); err != nil {
			t.Fatal(err)
		}
		if frame.SSRC != 123 || frame.PayloadType != 109 || !bytes.Equal(frame.Payload, []byte{0xf8, 0xff, 0xfe}) {
			t.Fatal("Pion probe or RTP wire serialization was bypassed")
		}
		if index > 0 && (frame.SequenceNumber != prior.SequenceNumber+1 || frame.Timestamp != prior.Timestamp+960) {
			t.Fatal("real Pion track changed the sender clock")
		}
		prior = frame
	}
	if err := s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := track.Unbind(ctx); err != nil {
		t.Fatal(err)
	}
}
