package livekit

import (
	"testing"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

type binding struct {
	id     string
	ssrc   webrtc.SSRC
	writer webrtc.TrackLocalWriter
}

func (b binding) CodecParameters() []webrtc.RTPCodecParameters {
	return []webrtc.RTPCodecParameters{{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, PayloadType: 111}}
}
func (b binding) HeaderExtensions() []webrtc.RTPHeaderExtensionParameter { return nil }
func (b binding) SSRC() webrtc.SSRC                                      { return b.ssrc }
func (b binding) SSRCRetransmission() webrtc.SSRC                        { return 0 }
func (b binding) SSRCForwardErrorCorrection() webrtc.SSRC                { return 0 }
func (b binding) WriteStream() webrtc.TrackLocalWriter                   { return b.writer }
func (b binding) ID() string                                             { return b.id }
func (b binding) RTCPReader() interceptor.RTCPReader                     { return nil }

type stream struct {
	packets chan rtp.Packet
	entered chan struct{}
	release chan struct{}
}

func (s *stream) WriteRTP(header *rtp.Header, payload []byte) (int, error) {
	if s.entered != nil {
		close(s.entered)
		<-s.release
	}
	s.packets <- rtp.Packet{Header: *header, Payload: append([]byte(nil), payload...)}
	return len(payload), nil
}
func (s *stream) Write(raw []byte) (int, error) {
	packet := &rtp.Packet{}
	if err := packet.Unmarshal(raw); err != nil {
		return 0, err
	}
	return s.WriteRTP(&packet.Header, packet.Payload)
}

func TestTrackRefusesBarePionUnboundSuccess(t *testing.T) {
	track, err := newTrack()
	if err != nil {
		t.Fatal(err)
	}
	packet := &rtp.Packet{Header: rtp.Header{Version: 2}, Payload: []byte{1}}
	if err := track.TrackLocalStaticRTP.WriteRTP(packet); err != nil {
		t.Fatalf("Pion baseline changed: %v", err)
	}
	if track.IsBound() || track.WriteRTP(packet) == nil {
		t.Fatal("unbound RTP was reported delivered")
	}
}

func TestTrackClosedBeforeNegotiationCannotBind(t *testing.T) {
	track, err := newTrack()
	if err != nil {
		t.Fatal(err)
	}
	if err := track.Close(); err != nil {
		t.Fatal(err)
	}
	writer := &stream{packets: make(chan rtp.Packet, 1)}
	if _, err := track.Bind(binding{id: "owner", ssrc: 7, writer: writer}); err == nil || track.IsBound() {
		t.Fatal("negotiation resurrected a closed track")
	}
}

func TestTrackUsesOneNegotiatedBindingAndNeverRebinds(t *testing.T) {
	track, err := newTrack()
	if err != nil {
		t.Fatal(err)
	}
	writer := &stream{packets: make(chan rtp.Packet, 1)}
	owner := binding{id: "owner", ssrc: 7, writer: writer}
	codec, err := track.Bind(owner)
	if err != nil || codec.PayloadType != 111 || !track.IsBound() {
		t.Fatalf("bind = %#v / %v", codec, err)
	}
	if _, err := track.Bind(binding{id: "other", ssrc: 8, writer: writer}); err == nil {
		t.Fatal("second binding was accepted")
	}
	if err := track.Unbind(binding{id: owner.id, ssrc: 8, writer: writer}); err == nil || !track.IsBound() {
		t.Fatal("changed target unbound the owner")
	}
	if err := track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: 12}, Payload: []byte{1, 2}}); err != nil {
		t.Fatal(err)
	}
	packet := <-writer.packets
	if packet.SSRC != 7 || packet.PayloadType != 111 || packet.SequenceNumber != 12 || len(packet.Payload) != 2 {
		t.Fatalf("actual Pion packet = %#v", packet)
	}
	if err := track.Unbind(owner); err != nil {
		t.Fatal(err)
	}
	if track.IsBound() || track.WriteRTP(&packet) == nil {
		t.Fatal("unbound track still wrote")
	}
	if _, err := track.Bind(owner); err == nil {
		t.Fatal("same-ID rebind reopened a retired target")
	}
}

func TestTrackCloseFencesWithoutWaitingForStuckPionWrite(t *testing.T) {
	track, err := newTrack()
	if err != nil {
		t.Fatal(err)
	}
	writer := &stream{packets: make(chan rtp.Packet, 1), entered: make(chan struct{}), release: make(chan struct{})}
	owner := binding{id: "owner", ssrc: 7, writer: writer}
	if _, err := track.Bind(owner); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2}, Payload: []byte{1}}) }()
	<-writer.entered
	closed := make(chan error, 1)
	go func() { closed <- track.Close() }()
	select {
	case err := <-closed:
		if err != nil || track.IsBound() {
			t.Fatal("close failed to fence immediately")
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("close blocked behind underlying RTP write")
	}
	refused := make(chan error, 1)
	go func() { refused <- track.WriteRTP(&rtp.Packet{}) }()
	select {
	case err := <-refused:
		if err == nil {
			t.Fatal("closed track accepted a write")
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("closed write waited behind stuck transport")
	}
	close(writer.release)
	if err := <-done; err == nil {
		t.Fatal("racing write completion was presented as confirmed delivery")
	}
	if _, err := track.Bind(owner); err == nil {
		t.Fatal("closed track accepted a binding")
	}
	if err := track.WriteRTP(&rtp.Packet{}); err == nil {
		t.Fatal("closed track accepted a write")
	}
}

func TestTrackUnbindWaitsForExactInFlightTarget(t *testing.T) {
	track, err := newTrack()
	if err != nil {
		t.Fatal(err)
	}
	writer := &stream{packets: make(chan rtp.Packet, 1), entered: make(chan struct{}), release: make(chan struct{})}
	owner := binding{id: "owner", ssrc: 7, writer: writer}
	if _, err := track.Bind(owner); err != nil {
		t.Fatal(err)
	}
	written := make(chan error, 1)
	go func() { written <- track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2}, Payload: []byte{1}}) }()
	<-writer.entered
	unbound := make(chan error, 1)
	go func() { unbound <- track.Unbind(owner) }()
	select {
	case err := <-unbound:
		t.Fatalf("binding changed inside synchronous write: %v", err)
	case <-time.After(10 * time.Millisecond):
	}
	close(writer.release)
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	if err := <-unbound; err != nil {
		t.Fatal(err)
	}
	if track.IsBound() {
		t.Fatal("unbind did not fence later writes")
	}
}
