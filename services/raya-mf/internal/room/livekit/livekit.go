//go:build cgo

// raya_change - LiveKit WebRTC room adapter for Raya's thin-client media path.
package livekit

import (
	"context"
	"encoding/binary"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/room"
	"github.com/livekit/media-sdk"
	"github.com/livekit/media-sdk/opus"
	lkproto "github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/logger"
	lksdk "github.com/livekit/server-sdk-go/v2"
	lkmedia "github.com/livekit/server-sdk-go/v2/pkg/media"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

type Factory struct{}

func (factory Factory) Join(ctx context.Context, url, token, name string) (room.Room, error) {
	return factory.JoinAuthorized(ctx, url, token, name, "")
}

func (factory Factory) JoinAuthorized(ctx context.Context, url, token, name string, client string) (room.Room, error) {
	return factory.JoinAudioAuthorized(ctx, url, token, name, client, 16000)
}

func (Factory) JoinAudioAuthorized(ctx context.Context, url, token, _ string, client string, rate int) (room.Room, error) {
	if rate != 16000 && rate != 24000 {
		return nil, errors.New("unsupported voice microphone sample rate")
	}
	if !strings.HasPrefix(client, "client-rvs_") || len(client) > 256 {
		return nil, errors.New("authorized voice client identity is required")
	}
	input := make(chan engine.Frame, 64)
	data := make(chan room.Data, 64)
	writer := &writer{input: input, rate: rate}
	var remoteMu sync.Mutex
	remote := make(map[string]*lkmedia.PCMRemoteTrack)
	tracks := make(map[string]*webrtc.TrackRemote)
	sinks := make(map[string]*sink)
	stopped := &atomic.Bool{}
	callback := &lksdk.RoomCallback{
		ParticipantCallback: lksdk.ParticipantCallback{
			OnTrackSubscribed: func(track *webrtc.TrackRemote, publication *lksdk.RemoteTrackPublication, participant *lksdk.RemoteParticipant) {
				if participant == nil || participant.Identity() != client {
					return
				}
				if publication.Source() != lkproto.TrackSource_MICROPHONE {
					return
				}
				if !strings.EqualFold(track.Codec().MimeType, webrtc.MimeTypeOpus) {
					return
				}
				remoteMu.Lock()
				defer remoteMu.Unlock()
				if stopped.Load() || len(remote) != 0 {
					return
				}
				input := &sink{writer: writer}
				decoded, err := lkmedia.NewPCMRemoteTrack(
					track,
					input,
					lkmedia.WithTargetSampleRate(rate),
					lkmedia.WithTargetChannels(1),
				)
				if err != nil {
					return
				}
				sid := publication.SID()
				remote[sid] = decoded
				tracks[sid] = track
				sinks[sid] = input
			},
			OnTrackUnsubscribed: func(track *webrtc.TrackRemote, publication *lksdk.RemoteTrackPublication, _ *lksdk.RemoteParticipant) {
				remoteMu.Lock()
				defer remoteMu.Unlock()
				if tracks[publication.SID()] != track {
					return
				}
				decoded := remote[publication.SID()]
				delete(remote, publication.SID())
				delete(tracks, publication.SID())
				if decoded != nil {
					_ = sinks[publication.SID()].Close()
					delete(sinks, publication.SID())
					_ = track.SetReadDeadline(time.Now())
					decoded.Close()
				}
			},
			OnDataPacket: func(packet lksdk.DataPacket, params lksdk.DataReceiveParams) {
				if params.SenderIdentity != client {
					return
				}
				user, ok := packet.(*lksdk.UserDataPacket)
				if !ok || user.Topic != "raya.playout" || len(user.Payload) > 4096 {
					return
				}
				remoteMu.Lock()
				defer remoteMu.Unlock()
				if stopped.Load() {
					return
				}
				select {
				case data <- room.Data{Identity: params.SenderIdentity, Topic: user.Topic, Body: append([]byte(nil), user.Payload...)}:
				default:
				}
			},
		},
	}
	joined := lksdk.NewRoom(callback)
	ready := false
	defer func() {
		if ready {
			return
		}
		remoteMu.Lock()
		stopped.Store(true)
		for sid, decoded := range remote {
			_ = sinks[sid].Close()
			delete(sinks, sid)
			_ = tracks[sid].SetReadDeadline(time.Now())
			decoded.Close()
			delete(remote, sid)
			delete(tracks, sid)
		}
		remoteMu.Unlock()
		_ = writer.Close()
	}()
	if err := joined.JoinWithContextAndToken(ctx, url, token); err != nil {
		joined.Disconnect()
		return nil, err
	}
	identity := joined.LocalParticipant.Identity()
	if identity != "media-"+strings.TrimPrefix(client, "client-") {
		joined.Disconnect()
		return nil, errors.New("unexpected media participant identity")
	}
	track, err := newTrack()
	if err != nil {
		joined.Disconnect()
		return nil, err
	}
	if _, err := joined.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{
		Name:   "raya-voice",
		Source: lkproto.TrackSource_MICROPHONE,
	}); err != nil {
		_ = track.Close()
		joined.Disconnect()
		return nil, err
	}
	output := &encoded{}
	codec, err := opus.Encode(output, 1, logger.GetLogger())
	if err != nil {
		_ = track.Close()
		joined.Disconnect()
		return nil, err
	}
	sender, err := newSender(func(packet *rtp.Packet) error {
		if !track.IsBound() {
			return errors.New("voice RTP track is not bound")
		}
		return track.WriteRTP(packet)
	})
	if err != nil {
		_ = codec.Close()
		_ = track.Close()
		joined.Disconnect()
		return nil, err
	}
	control, err := newControl(func(data room.Data) error {
		if stopped.Load() {
			return controlStopped
		}
		packet := lksdk.UserData(data.Body)
		packet.Topic = data.Topic
		return joined.LocalParticipant.PublishDataPacket(packet, lksdk.WithDataPublishReliable(true), lksdk.WithDataPublishDestination([]string{client}))
	})
	if err != nil {
		_ = sender.Close(ctx)
		_ = codec.Close()
		_ = track.Close()
		joined.Disconnect()
		return nil, err
	}
	ready = true
	return &Room{
		room:     joined,
		track:    track,
		codec:    codec,
		encoded:  output,
		sender:   sender,
		control:  control,
		writer:   writer,
		input:    input,
		data:     data,
		remote:   remote,
		remoteMu: &remoteMu,
		tracks:   tracks,
		sinks:    sinks,
		stopped:  stopped,
		done:     make(chan struct{}),
	}, nil
}

type Room struct {
	room     *lksdk.Room
	track    *track
	codec    media.PCM16Writer
	encoded  *encoded
	sender   *sender
	control  *control
	mu       sync.Mutex
	closed   bool
	err      error
	done     chan struct{}
	writer   *writer
	input    chan engine.Frame
	data     chan room.Data
	remote   map[string]*lkmedia.PCMRemoteTrack
	remoteMu *sync.Mutex
	tracks   map[string]*webrtc.TrackRemote
	sinks    map[string]*sink
	stopped  *atomic.Bool
	once     sync.Once
}

func (r *Room) Input() <-chan engine.Frame {
	return r.input
}

func (r *Room) Data() <-chan room.Data {
	return r.data
}

func (r *Room) Publish(ctx context.Context, frame engine.Frame) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !r.mu.TryLock() {
		return errors.New("voice publication is already active")
	}
	defer r.mu.Unlock()
	if r.closed || !r.track.IsBound() {
		return errors.New("voice RTP track is closed or unbound")
	}
	if frame.Rate != 24000 || len(frame.PCM) != 960 {
		return errors.New("voice publication requires one 20 ms mono PCM16 frame at 24 kHz")
	}
	samples := make(media.PCM16Sample, len(frame.PCM)/2)
	for index := range samples {
		samples[index] = int16(binary.LittleEndian.Uint16(frame.PCM[index*2:]))
	}
	r.encoded.packet = nil
	if err := r.codec.WriteSample(samples); err != nil {
		r.closed = true
		r.halt()
		return errors.New("voice frame encoding failed")
	}
	if err := r.sender.Send(ctx, r.encoded.packet); err != nil {
		r.closed = true
		r.halt()
		return err
	}
	return nil
}

func (r *Room) Send(ctx context.Context, data room.Data) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if r.stopped.Load() {
		return controlStopped
	}
	err := r.control.Send(ctx, data)
	if errors.Is(err, controlUnknown) {
		r.halt()
	}
	return err
}

func (r *Room) Flush(ctx context.Context, _ string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !r.mu.TryLock() {
		return errors.New("voice publication has not drained")
	}
	defer r.mu.Unlock()
	if r.closed {
		return errors.New("voice transport is closed")
	}
	// There is no local PCM queue. This is a local publication barrier only;
	// already-sent RTP and the remote jitter buffer still need exact receipts.
	return r.sender.Idle()
}

func (r *Room) Close() error {
	r.halt()
	ctx, cancel := context.WithTimeout(context.Background(), 2*engine.FramePeriod)
	defer cancel()
	select {
	case <-r.done:
		return r.err
	case <-ctx.Done():
		return errors.Join(errUnknown, ctx.Err())
	}
}

func (r *Room) halt() {
	r.once.Do(func() {
		// Fence input/output immediately. At most one retained cleanup owner
		// may block inside the SDK; a deadline never reports it as drained.
		r.stopped.Store(true)
		r.control.stop()
		r.sender.stop()
		r.writer.closed.Store(true)
		go func() {
			defer close(r.done)
			_ = r.track.Close()
			_ = r.writer.Close()
			r.remoteMu.Lock()
			for sid, track := range r.tracks {
				_ = r.sinks[sid].Close()
				_ = track.SetReadDeadline(time.Now())
			}
			r.remoteMu.Unlock()
		drain:
			for {
				select {
				case <-r.input:
				default:
					break drain
				}
			}
			r.room.Disconnect()
			ctx, cancel := context.WithTimeout(context.Background(), 2*engine.FramePeriod)
			defer cancel()
			r.err = r.sender.Close(ctx)
			r.err = errors.Join(r.err, r.control.Close(ctx))
			// A timed-out SDK handoff retains its owner until actual return.
			// Closing done must not fabricate that the control worker drained.
			<-r.control.end
			<-r.sender.end
			r.remoteMu.Lock()
			for sid, decoded := range r.remote {
				_ = r.sinks[sid].Close()
				delete(r.sinks, sid)
				_ = r.tracks[sid].SetReadDeadline(time.Now())
				decoded.Close()
				delete(r.tracks, sid)
				delete(r.remote, sid)
			}
			r.remoteMu.Unlock()
			r.mu.Lock()
			r.closed = true
			r.err = errors.Join(r.err, r.codec.Close())
			r.mu.Unlock()
		}()
	})
}

// The SDK encoder writes synchronously into this bounded sink. No sample
// provider, private PCM queue, resampler or independent timer is installed.
type encoded struct {
	packet []byte
}

func (*encoded) String() string  { return "raya-opus" }
func (*encoded) SampleRate() int { return 24000 }
func (e *encoded) WriteSample(sample opus.Sample) error {
	if len(sample) == 0 || len(sample) > 1275 || e.packet != nil {
		return errors.New("invalid or duplicate encoded voice packet")
	}
	e.packet = append([]byte(nil), sample...)
	return nil
}
func (e *encoded) Close() error {
	e.packet = nil
	return nil
}

type writer struct {
	input  chan<- engine.Frame
	rate   int
	closed atomic.Bool
	mu     sync.RWMutex
}

func (w *writer) WriteSample(sample media.PCM16Sample) error {
	w.mu.RLock()
	defer w.mu.RUnlock()
	if w.closed.Load() {
		return errors.New("LiveKit PCM writer is closed")
	}
	if len(sample) != w.rate/50 {
		return errors.New("microphone decoder requires one 20 ms mono frame")
	}
	pcm := make([]byte, len(sample)*2)
	for index, value := range sample {
		binary.LittleEndian.PutUint16(pcm[index*2:], uint16(value))
	}
	select {
	case w.input <- engine.Frame{PCM: pcm, Rate: w.rate}:
	default:
	}
	return nil
}

func (w *writer) Close() error {
	w.mu.Lock()
	w.closed.Store(true)
	w.mu.Unlock()
	return nil
}

// Each decoder owns only its sink. Retiring a microphone must not close the
// room-wide PCM input used by a later authorized microphone publication.
type sink struct {
	writer *writer
	mu     sync.RWMutex
	closed bool
}

func (s *sink) String() string  { return "raya-microphone" }
func (s *sink) SampleRate() int { return s.writer.rate }
func (s *sink) WriteSample(frame media.PCM16Sample) error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.closed {
		return errors.New("microphone decoder retired")
	}
	return s.writer.WriteSample(frame)
}
func (s *sink) Close() error {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	return nil
}
