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
	return join(ctx, func(owner *setup) (room.Room, error) {
		return native(ctx, url, token, client, rate, owner)
	})
}

func native(ctx context.Context, url, token, client string, rate int, owner *setup) (room.Room, error) {
	sealed := func() bool { return owner.stopped() || ctx.Err() != nil }
	if sealed() {
		return nil, context.Canceled
	}
	input := make(chan engine.Frame, 64)
	data := make(chan room.Data, 64)
	failure := make(chan error, 1)
	refuse := func(err error) {
		select {
		case failure <- err:
		default:
		}
	}
	writer := &writer{input: input, rate: rate, guard: sealed}
	var remoteMu sync.Mutex
	remote := make(map[string]*receiver)
	tracks := make(map[string]*webrtc.TrackRemote)
	sinks := make(map[string]*sink)
	stopped := &atomic.Bool{}
	callback := &lksdk.RoomCallback{
		OnDisconnected: func() {
			if !stopped.Load() && !sealed() {
				refuse(errors.New("voice room disconnected"))
			}
		},
		ParticipantCallback: lksdk.ParticipantCallback{
			OnTrackSubscribed: func(track *webrtc.TrackRemote, publication *lksdk.RemoteTrackPublication, participant *lksdk.RemoteParticipant) {
				if participant == nil || participant.Identity() != client {
					return
				}
				if publication.Source() != lkproto.TrackSource_MICROPHONE {
					return
				}
				if !strings.EqualFold(track.Codec().MimeType, webrtc.MimeTypeOpus) {
					refuse(errors.New("authorized microphone codec is unsupported"))
					return
				}
				remoteMu.Lock()
				defer remoteMu.Unlock()
				if stopped.Load() || sealed() {
					return
				}
				for sid, retired := range remote {
					if !retired.stopped.Load() {
						return
					}
					select {
					case <-retired.end:
						discard(input)
						delete(remote, sid)
						delete(tracks, sid)
						delete(sinks, sid)
					default:
						refuse(receiverUnknown)
						return
					}
				}
				input := &sink{writer: writer}
				decoded, err := newMicrophone(func() (*rtp.Packet, error) {
					packet, _, err := track.ReadRTP()
					return packet, err
				}, func() error { return track.SetReadDeadline(time.Now()) }, input, failure)
				if err != nil {
					refuse(err)
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
				if decoded != nil {
					_ = sinks[publication.SID()].Close()
					discard(input)
					ctx, cancel := context.WithTimeout(context.Background(), deadline)
					defer cancel()
					_ = decoded.Close(ctx)
					select {
					case <-decoded.end:
						delete(remote, publication.SID())
						delete(tracks, publication.SID())
						delete(sinks, publication.SID())
					default:
						// Retain the exact retired owner until actual termination.
					}
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
				if stopped.Load() || sealed() {
					return
				}
				select {
				case data <- room.Data{Identity: params.SenderIdentity, Topic: user.Topic, Body: append([]byte(nil), user.Payload...)}:
				default:
				}
			},
		},
	}
	if sealed() {
		return nil, context.Canceled
	}
	joined := lksdk.NewRoom(callback)
	var track *track
	var codec media.PCM16Writer
	var sender *sender
	var control *control
	ready := false
	defer func() {
		if ready {
			return
		}
		stopped.Store(true)
		writer.closed.Store(true)
		if track != nil {
			owner.settle(track.Close())
		}
		if sender != nil {
			sender.stop()
		}
		if control != nil {
			control.stop()
		}
		remoteMu.Lock()
		retired := make([]*receiver, 0, len(remote))
		for sid, decoded := range remote {
			owner.settle(sinks[sid].Close())
			decoded.stop()
			retired = append(retired, decoded)
		}
		remoteMu.Unlock()
		owner.settle(writer.Close())
		owner.settle(disconnect(joined))
		// Waiting belongs to this one retained setup owner, outside admission
		// locks. Caller cancellation cannot fabricate native termination.
		for _, decoded := range retired {
			<-decoded.end
			owner.settle(decoded.Close(context.Background()))
		}
		if sender != nil {
			<-sender.end
			owner.settle(sender.Close(context.Background()))
		}
		if control != nil {
			<-control.end
			owner.settle(control.Close(context.Background()))
		}
		if codec != nil {
			owner.settle(codec.Close())
		}
		discard(input)
	}()
	if err := joined.JoinWithContextAndToken(ctx, url, token); err != nil {
		return nil, err
	}
	if sealed() {
		return nil, context.Canceled
	}
	identity := joined.LocalParticipant.Identity()
	if identity != "media-"+strings.TrimPrefix(client, "client-") {
		return nil, errors.New("unexpected media participant identity")
	}
	var err error
	track, err = newTrack()
	if err != nil {
		return nil, err
	}
	if sealed() {
		return nil, context.Canceled
	}
	if _, err := joined.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{
		Name:   "raya-voice",
		Source: lkproto.TrackSource_MICROPHONE,
	}); err != nil {
		return nil, err
	}
	if sealed() {
		return nil, context.Canceled
	}
	output := &encoded{}
	codec, err = opus.Encode(output, 1, logger.GetLogger())
	if err != nil {
		return nil, err
	}
	if sealed() {
		return nil, context.Canceled
	}
	sender, err = newSender(func(packet *rtp.Packet) error {
		if sealed() || !track.IsBound() {
			return errors.New("voice RTP track is not bound")
		}
		return track.WriteRTP(packet)
	})
	if err != nil {
		return nil, err
	}
	if sealed() {
		return nil, context.Canceled
	}
	control, err = newControl(func(data room.Data) error {
		if stopped.Load() || sealed() {
			return controlStopped
		}
		packet := lksdk.UserData(data.Body)
		packet.Topic = data.Topic
		return joined.LocalParticipant.PublishDataPacket(packet, lksdk.WithDataPublishReliable(true), lksdk.WithDataPublishDestination([]string{client}))
	})
	if err != nil {
		return nil, err
	}
	if sealed() {
		return nil, context.Canceled
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
		failure:  failure,
		remote:   remote,
		remoteMu: &remoteMu,
		tracks:   tracks,
		sinks:    sinks,
		stopped:  stopped,
		done:     make(chan struct{}),
		joined:   true,
	}, nil
}

// Public Pion peers expose a real goroutine join. The pinned SDK engine and
// signaling cleanup do not: Disconnected state and Disconnect returning are
// handoffs, so retain an explicit unknown receipt until that bridge exists.
func disconnect(joined *lksdk.Room) error {
	publisher := joined.LocalParticipant.GetPublisherPeerConnection()
	subscriber := joined.LocalParticipant.GetSubscriberPeerConnection()
	joined.Disconnect()
	err := room.ErrCleanupUnknown
	if publisher != nil {
		err = errors.Join(err, publisher.GracefulClose())
	}
	if subscriber != nil && subscriber != publisher {
		err = errors.Join(err, subscriber.GracefulClose())
	}
	return err
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
	failure  chan error
	remote   map[string]*receiver
	remoteMu *sync.Mutex
	tracks   map[string]*webrtc.TrackRemote
	sinks    map[string]*sink
	stopped  *atomic.Bool
	once     sync.Once
	joined   bool
}

func (r *Room) Input() <-chan engine.Frame {
	return r.input
}

func (r *Room) Data() <-chan room.Data {
	return r.data
}

func (r *Room) Failure() <-chan error {
	return r.failure
}

func (r *Room) Done() <-chan struct{} { return r.done }
func (r *Room) Err() error {
	select {
	case <-r.done:
		return r.err
	default:
		return errUnknown
	}
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
			for sid, decoded := range r.remote {
				_ = r.sinks[sid].Close()
				decoded.stop()
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
			if r.joined {
				r.err = disconnect(r.room)
			}
			if !r.joined {
				r.room.Disconnect()
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*engine.FramePeriod)
			defer cancel()
			_ = r.sender.Close(ctx)
			_ = r.control.Close(ctx)
			// A timed-out SDK handoff retains its owner until actual return.
			// Closing done must not fabricate that the control worker drained.
			<-r.control.end
			<-r.sender.end
			// These are actual local owner receipts. They do not change an
			// earlier unknown Send outcome or authorize replay of its effects.
			r.err = errors.Join(r.err, r.sender.Close(context.Background()), r.control.Close(context.Background()))
			r.remoteMu.Lock()
			for sid, decoded := range r.remote {
				_ = r.sinks[sid].Close()
				delete(r.sinks, sid)
				_ = decoded.Close(ctx)
				<-decoded.end
				r.err = errors.Join(r.err, decoded.Close(context.Background()))
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
	guard  func() bool
	mu     sync.RWMutex
}

func (w *writer) WriteSample(sample media.PCM16Sample) error {
	w.mu.RLock()
	defer w.mu.RUnlock()
	if w.closed.Load() || (w.guard != nil && w.guard()) {
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
		return errors.New("microphone input exceeded its bounded frame allowance")
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

// The sole microphone sink is fenced before retirement drains its old frames.
// Bound the drain by the room's existing capacity; no replacement is admitted
// while an old receiver is still active or its termination remains unknown.
func discard(input <-chan engine.Frame) {
	for index := 0; index < 64; index++ {
		select {
		case <-input:
		default:
			return
		}
	}
}
