//go:build cgo

// raya_change - LiveKit WebRTC room adapter for Raya's thin-client media path.
package livekit

import (
	"context"
	"encoding/binary"
	"errors"
	"strings"
	"sync"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/room"
	"github.com/livekit/media-sdk"
	lkproto "github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/logger"
	lksdk "github.com/livekit/server-sdk-go/v2"
	lkmedia "github.com/livekit/server-sdk-go/v2/pkg/media"
	"github.com/pion/webrtc/v4"
)

type Factory struct{}

func (Factory) Join(_ context.Context, url, token, _ string) (room.Room, error) {
	input := make(chan engine.Frame, 64)
	data := make(chan room.Data, 64)
	writer := &writer{input: input}
	var remoteMu sync.Mutex
	remote := make(map[string]*lkmedia.PCMRemoteTrack)
	callback := &lksdk.RoomCallback{
		ParticipantCallback: lksdk.ParticipantCallback{
			OnTrackSubscribed: func(track *webrtc.TrackRemote, publication *lksdk.RemoteTrackPublication, _ *lksdk.RemoteParticipant) {
				if publication.Source() != lkproto.TrackSource_MICROPHONE {
					return
				}
				if !strings.EqualFold(track.Codec().MimeType, webrtc.MimeTypeOpus) {
					return
				}
				decoded, err := lkmedia.NewPCMRemoteTrack(
					track,
					writer,
					lkmedia.WithTargetSampleRate(16000),
					lkmedia.WithTargetChannels(1),
				)
				if err != nil {
					return
				}
				remoteMu.Lock()
				sid := publication.SID()
				old := remote[sid]
				remote[sid] = decoded
				remoteMu.Unlock()
				if old != nil {
					_ = old.Close()
				}
			},
			OnTrackUnsubscribed: func(_ *webrtc.TrackRemote, publication *lksdk.RemoteTrackPublication, _ *lksdk.RemoteParticipant) {
				remoteMu.Lock()
				decoded := remote[publication.SID()]
				delete(remote, publication.SID())
				remoteMu.Unlock()
				if decoded != nil {
					_ = decoded.Close()
				}
			},
			OnDataPacket: func(packet lksdk.DataPacket, _ lksdk.DataReceiveParams) {
				user, ok := packet.(*lksdk.UserDataPacket)
				if !ok {
					return
				}
				select {
				case data <- room.Data{Topic: user.Topic, Body: user.Payload}:
				default:
				}
			},
		},
	}
	joined, err := lksdk.ConnectToRoomWithToken(url, token, callback)
	if err != nil {
		return nil, err
	}
	track, err := lkmedia.NewPCMLocalTrack(24000, 1, logger.GetLogger())
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
	return &Room{
		room:     joined,
		track:    track,
		writer:   writer,
		input:    input,
		data:     data,
		remote:   remote,
		remoteMu: &remoteMu,
	}, nil
}

type Room struct {
	room     *lksdk.Room
	track    *lkmedia.PCMLocalTrack
	writer   *writer
	input    chan engine.Frame
	data     chan room.Data
	remote   map[string]*lkmedia.PCMRemoteTrack
	remoteMu *sync.Mutex
	once     sync.Once
}

func (r *Room) Input() <-chan engine.Frame {
	return r.input
}

func (r *Room) Data() <-chan room.Data {
	return r.data
}

func (r *Room) Publish(_ context.Context, frame engine.Frame) error {
	if len(frame.PCM)%2 != 0 {
		return errors.New("PCM16 frame has an odd byte length")
	}
	samples := make(media.PCM16Sample, len(frame.PCM)/2)
	for index := range samples {
		samples[index] = int16(binary.LittleEndian.Uint16(frame.PCM[index*2:]))
	}
	return r.track.WriteSample(samples)
}

func (r *Room) Send(_ context.Context, data room.Data) error {
	packet := lksdk.UserData(data.Body)
	packet.Topic = data.Topic
	return r.room.LocalParticipant.PublishDataPacket(packet, lksdk.WithDataPublishReliable(true))
}

func (r *Room) Flush(context.Context, string) error {
	r.track.ClearQueue()
	return nil
}

func (r *Room) Close() error {
	var err error
	r.once.Do(func() {
		r.writer.Close()
		r.remoteMu.Lock()
		for sid, decoded := range r.remote {
			err = errors.Join(err, decoded.Close())
			delete(r.remote, sid)
		}
		r.remoteMu.Unlock()
		r.track.ClearQueue()
		err = errors.Join(err, r.track.Close())
		r.room.Disconnect()
	})
	return err
}

type writer struct {
	input  chan<- engine.Frame
	closed bool
	mu     sync.RWMutex
}

func (w *writer) WriteSample(sample media.PCM16Sample) error {
	w.mu.RLock()
	defer w.mu.RUnlock()
	if w.closed {
		return errors.New("LiveKit PCM writer is closed")
	}
	pcm := make([]byte, len(sample)*2)
	for index, value := range sample {
		binary.LittleEndian.PutUint16(pcm[index*2:], uint16(value))
	}
	select {
	case w.input <- engine.Frame{PCM: pcm, Rate: 16000}:
	default:
	}
	return nil
}

func (w *writer) Close() error {
	w.mu.Lock()
	w.closed = true
	w.mu.Unlock()
	return nil
}
