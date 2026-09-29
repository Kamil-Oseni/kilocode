//go:build cgo

// raya_change - Explicit local SFU/libopus gate; synthetic PCM, no device or provider audio.
package livekit

import (
	"context"
	"encoding/binary"
	"errors"
	"math"
	"net"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/livekit/media-sdk"
	"github.com/livekit/media-sdk/opus"
	"github.com/livekit/protocol/auth"
	lkproto "github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/logger"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

type samples struct{ frames chan media.PCM16Sample }

func (*samples) String() string  { return "sfu-synthetic-receiver" }
func (*samples) SampleRate() int { return 24000 }
func (*samples) Close() error    { return nil }
func (s *samples) WriteSample(frame media.PCM16Sample) error {
	copy := append(media.PCM16Sample(nil), frame...)
	select {
	case s.frames <- copy:
		return nil
	default:
		return errors.New("test decoder bound exceeded")
	}
}

func TestLiveKitSFUSyntheticPCM(t *testing.T) {
	raw := os.Getenv("RAYA_TEST_LIVEKIT_URL")
	if raw == "" {
		t.Skip("set explicit local RAYA_TEST_LIVEKIT_URL to run the real SFU gate")
	}
	uri, err := url.Parse(raw)
	if err != nil || uri.User != nil || uri.RawQuery != "" || uri.Fragment != "" || (uri.Scheme != "http" && uri.Scheme != "ws") || (uri.Hostname() != "localhost" && !net.ParseIP(uri.Hostname()).IsLoopback()) {
		t.Fatal("SFU gate requires an explicit loopback-only test URL")
	}
	key, secret := os.Getenv("RAYA_TEST_LIVEKIT_KEY"), os.Getenv("RAYA_TEST_LIVEKIT_SECRET")
	if key == "" || secret == "" {
		t.Fatal("SFU gate requires explicit test-only key and secret")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	id := "rvs_sfutest_" + strings.ReplaceAll(time.Now().UTC().Format("150405.000000000"), ".", "")
	name, client, owner := "raya-test-"+id, "client-"+id, "media-"+id
	token := func(identity string) string {
		t.Helper()
		value, err := auth.NewAccessToken(key, secret).SetIdentity(identity).SetValidFor(time.Minute).SetVideoGrant(&auth.VideoGrant{RoomJoin: true, Room: name}).ToJWT()
		if err != nil {
			t.Fatal("test token could not be created")
		}
		return value
	}
	wait := func(check func() bool, message string) {
		t.Helper()
		timer := time.NewTimer(4 * time.Second)
		defer timer.Stop()
		tick := time.NewTicker(10 * time.Millisecond)
		defer tick.Stop()
		for {
			if check() {
				return
			}
			select {
			case <-ctx.Done():
				t.Fatal("SFU overall deadline", message)
			case <-timer.C:
				t.Fatal(message)
			case <-tick.C:
			}
		}
	}
	frames := &samples{frames: make(chan media.PCM16Sample, 64)}
	failures := make(chan error, 4)
	started, done := make(chan struct{}), make(chan struct{})
	var once sync.Once
	receiver := lksdk.NewRoom(&lksdk.RoomCallback{ParticipantCallback: lksdk.ParticipantCallback{OnTrackSubscribed: func(track *webrtc.TrackRemote, pub *lksdk.RemoteTrackPublication, participant *lksdk.RemoteParticipant) {
		if participant.Identity() != owner || pub.Source() != lkproto.TrackSource_MICROPHONE {
			return
		}
		once.Do(func() {
			close(started)
			go func() {
				defer close(done)
				decoder, err := opus.Decode(frames, 1, logger.GetLogger())
				if err != nil {
					failures <- err
					return
				}
				defer decoder.Close()
				stop := context.AfterFunc(ctx, func() { _ = track.SetReadDeadline(time.Now()) })
				defer stop()
				deadline, _ := ctx.Deadline()
				if err := track.SetReadDeadline(deadline); err != nil {
					failures <- err
					return
				}
				for {
					packet, _, err := track.ReadRTP()
					if err != nil {
						if ctx.Err() == nil {
							failures <- err
						}
						return
					}
					if track.Codec().MimeType != webrtc.MimeTypeOpus {
						failures <- errors.New("SFU changed output codec")
						return
					}
					if err := decoder.WriteSample(packet.Payload); err != nil {
						failures <- err
						return
					}
				}
			}()
		})
	}}})
	outsider := lksdk.NewRoom(nil)
	var adapter *Room
	var senders []*sender
	var encoders []media.PCM16Writer
	t.Cleanup(func() {
		cancel()
		ended := make(chan error, 1)
		// One retained cleanup owner bounds SDK disconnect calls too. A timeout
		// is a failing gate, never a successful claim of complete shutdown.
		go func() {
			var failure error
			receiver.Disconnect()
			outsider.Disconnect()
			if adapter != nil {
				_ = adapter.Close()
				select {
				case <-adapter.done:
					failure = errors.Join(failure, adapter.Close())
				case <-time.After(2 * time.Second):
					failure = errors.Join(failure, errors.New("adapter retained a cleanup owner"))
				}
			}
			for _, source := range senders {
				stop, end := context.WithTimeout(context.Background(), 100*time.Millisecond)
				failure = errors.Join(failure, source.Close(stop))
				end()
			}
			for _, codec := range encoders {
				failure = errors.Join(failure, codec.Close())
			}
			select {
			case <-started:
				select {
				case <-done:
				case <-time.After(time.Second):
					failure = errors.Join(failure, errors.New("test decoder owner did not terminate"))
				}
			default:
			}
			ended <- failure
		}()
		select {
		case err := <-ended:
			if err != nil {
				t.Error("actual SFU cleanup failed", err)
			}
		case <-time.After(5 * time.Second):
			t.Error("actual SFU cleanup owner remained blocked")
		}
	})
	if err := receiver.JoinWithContextAndToken(ctx, raw, token(client)); err != nil {
		t.Fatal("synthetic client could not join local SFU")
	}
	if err := outsider.JoinWithContextAndToken(ctx, raw, token("outsider-"+id)); err != nil {
		t.Fatal("test outsider could not join local SFU")
	}
	joined, err := (Factory{}).JoinAudioAuthorized(ctx, raw, token(owner), name, client, 24000)
	if err != nil {
		t.Fatal("production adapter could not join actual local SFU")
	}
	adapter = joined.(*Room)
	microphone := func(participant *lksdk.Room, source lkproto.TrackSource) func(int) {
		t.Helper()
		track, err := lksdk.NewLocalTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2})
		if err != nil {
			t.Fatal(err)
		}
		publication, err := participant.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: "synthetic-20ms", Source: source, DisableDTX: true})
		if err != nil {
			t.Fatal("synthetic track publication failed")
		}
		wait(track.IsBound, "synthetic RTP track did not bind")
		output := &encoded{}
		codec, err := opus.Encode(output, 1, logger.GetLogger())
		if err != nil {
			t.Fatal(err)
		}
		encoders = append(encoders, codec)
		owned, err := newSender(func(packet *rtp.Packet) error { return track.WriteRTP(packet, nil) })
		if err != nil {
			t.Fatal(err)
		}
		senders = append(senders, owned)
		return func(count int) {
			t.Helper()
			tick := time.NewTicker(engine.FramePeriod)
			defer tick.Stop()
			for index := 0; index < count; index++ {
				select {
				case <-ctx.Done():
					t.Fatal("synthetic input deadline")
				case <-tick.C:
				}
				output.packet = nil
				sample := make(media.PCM16Sample, 480)
				for offset := range sample {
					sample[offset] = int16(2000 * math.Sin(2*math.Pi*440*float64(index*480+offset)/24000))
				}
				if err := codec.WriteSample(sample); err != nil {
					t.Fatal(err)
				}
				send, end := context.WithTimeout(ctx, 40*time.Millisecond)
				err := owned.Send(send, output.packet)
				end()
				if err != nil {
					t.Fatal("actual synthetic RTP send failed", err)
				}
			}
			wait(func() bool {
				remote := adapter.room.GetParticipantByIdentity(participant.LocalParticipant.Identity())
				if remote == nil {
					return false
				}
				for _, track := range remote.TrackPublications() {
					if track.SID() == publication.SID() && track.Source() == source && track.IsSubscribed() {
						return true
					}
				}
				return false
			}, "actual SFU did not subscribe to synthetic source")
		}
	}
	reject := func() {
		t.Helper()
		select {
		case <-adapter.Input():
			t.Fatal("unauthorized participant/source entered production PCM input")
		case <-time.After(120 * time.Millisecond):
		}
		adapter.remoteMu.Lock()
		count := len(adapter.remote)
		adapter.remoteMu.Unlock()
		if count != 0 {
			t.Fatal("production adapter allocated unauthorized decoder")
		}
	}
	microphone(outsider, lkproto.TrackSource_MICROPHONE)(12)
	reject()
	microphone(receiver, lkproto.TrackSource_SCREEN_SHARE_AUDIO)(12)
	reject()
	microphone(receiver, lkproto.TrackSource_MICROPHONE)(24)
	select {
	case frame := <-adapter.Input():
		if frame.Rate != 24000 || len(frame.PCM) != 960 {
			t.Fatal("actual Opus input did not decode to mono 24kHz/20ms")
		}
		signal := false
		for offset := 0; offset < len(frame.PCM); offset += 2 {
			if int16(binary.LittleEndian.Uint16(frame.PCM[offset:])) != 0 {
				signal = true
			}
		}
		if !signal {
			t.Fatal("authorized SFU input carried no decoded synthetic signal")
		}
	case err := <-failures:
		t.Fatal(err)
	case <-time.After(2 * time.Second):
		t.Fatal("authorized microphone produced no real decoded PCM")
	}
	wait(adapter.track.IsBound, "production output RTP track was not bound")
	tick := time.NewTicker(engine.FramePeriod)
	for index := 0; index < 24; index++ {
		select {
		case <-ctx.Done():
			tick.Stop()
			t.Fatal("output deadline")
		case <-tick.C:
		}
		pcm := make([]byte, 960)
		for offset := 0; offset < 480; offset++ {
			binary.LittleEndian.PutUint16(pcm[offset*2:], uint16(int16(2000*math.Sin(2*math.Pi*880*float64(index*480+offset)/24000))))
		}
		send, end := context.WithTimeout(ctx, 40*time.Millisecond)
		err := adapter.Publish(send, engine.Frame{Rate: 24000, PCM: pcm})
		end()
		if err != nil {
			tick.Stop()
			t.Fatal("production output RTP failed", err)
		}
	}
	tick.Stop()
	select {
	case sample := <-frames.frames:
		if len(sample) != 480 {
			t.Fatal("actual output libopus decode changed 20ms frame size")
		}
		signal := false
		for _, value := range sample {
			if value != 0 {
				signal = true
			}
		}
		if !signal {
			t.Fatal("client received no actual decoded output signal")
		}
	case err := <-failures:
		t.Fatal(err)
	case <-time.After(2 * time.Second):
		t.Fatal("actual SFU output did not reach client decoder")
	}
	_ = adapter.Close()
	if adapter.Publish(context.Background(), engine.Frame{Rate: 24000, PCM: make([]byte, 960)}) == nil {
		t.Fatal("shutdown did not immediately fence RTP publication")
	}
	select {
	case <-adapter.done:
		if err := adapter.Close(); err != nil {
			t.Fatal("actual adapter cleanup failed", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("actual SFU cleanup remained unknown")
	}
}
