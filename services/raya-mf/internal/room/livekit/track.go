// raya_change - One immutable RTP binding with immediate local close fencing.
package livekit

import (
	"errors"
	"sync"
	"sync/atomic"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

type track struct {
	*webrtc.TrackLocalStaticRTP
	mu     sync.Mutex
	closed atomic.Bool
	bound  atomic.Bool
	once   bool
	id     string
	ssrc   webrtc.SSRC
}

func newTrack() (*track, error) {
	rtp, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "raya-voice", "raya")
	if err != nil {
		return nil, err
	}
	return &track{TrackLocalStaticRTP: rtp}, nil
}

func (t *track) Bind(ctx webrtc.TrackLocalContext) (webrtc.RTPCodecParameters, error) {
	if t.closed.Load() {
		return webrtc.RTPCodecParameters{}, errors.New("voice RTP binding is sealed")
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed.Load() || t.once {
		return webrtc.RTPCodecParameters{}, errors.New("voice RTP binding is sealed")
	}
	if ctx == nil || ctx.ID() == "" || ctx.WriteStream() == nil {
		return webrtc.RTPCodecParameters{}, errors.New("voice RTP binding is invalid")
	}
	codec, err := t.TrackLocalStaticRTP.Bind(ctx)
	if err != nil {
		return webrtc.RTPCodecParameters{}, err
	}
	t.once, t.id, t.ssrc = true, ctx.ID(), ctx.SSRC()
	t.bound.Store(true)
	if t.closed.Load() {
		return webrtc.RTPCodecParameters{}, errors.New("voice RTP track closed during binding")
	}
	return codec, nil
}

func (t *track) Unbind(ctx webrtc.TrackLocalContext) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if ctx == nil || !t.bound.Load() || ctx.ID() != t.id || ctx.SSRC() != t.ssrc {
		return errors.New("voice RTP unbinding does not match its owner")
	}
	err := t.TrackLocalStaticRTP.Unbind(ctx)
	if err != nil {
		return err
	}
	t.bound.Store(false)
	return nil
}

func (t *track) IsBound() bool {
	return !t.closed.Load() && t.bound.Load()
}

func (t *track) WriteRTP(packet *rtp.Packet) error {
	if !t.IsBound() {
		return errors.New("voice RTP track is unbound or closed")
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.IsBound() {
		return errors.New("voice RTP track is unbound or closed")
	}
	if packet == nil {
		return errors.New("voice RTP packet is required")
	}
	err := t.TrackLocalStaticRTP.WriteRTP(packet)
	if t.closed.Load() {
		return errors.New("voice RTP write completion after close is unknown")
	}
	return err
}

// Close fences new work immediately. It does not wait for an in-flight write
// or claim that Pion/SRTP drained; the room owner must disconnect the transport.
func (t *track) Close() error {
	t.closed.Store(true)
	return nil
}
