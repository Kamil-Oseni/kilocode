//go:build cgo && !windows

package process

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/room"
	"github.com/livekit/media-sdk"
	"github.com/livekit/media-sdk/opus"
	"github.com/livekit/protocol/auth"
	lkproto "github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/logger"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

var tones = [...]float64{750, 1050, 1450, 1950, 2550, 3150, 3750, 4350}

type signature struct {
	order  [8]int
	stage  int
	last   int
	streak int
	blank  int
	done   bool
	first  time.Time
}

func watermark(id int) [8]int {
	if id < 0 || id >= 24 {
		panic("synthetic marker identity must be within 0..23")
	}
	var order [8]int
	step := []int{1, 3, 5}[id/8]
	for index := range order {
		order[index] = (id + index*step) % 8
	}
	return order
}

func tone(symbol int) media.PCM16Sample {
	frame := make(media.PCM16Sample, 480)
	if symbol < 0 {
		return frame
	}
	for index := range frame {
		frame[index] = int16(10000 * math.Sin(2*math.Pi*tones[symbol]*float64(index)/24000))
	}
	return frame
}

func classify(frame media.PCM16Sample) int {
	if len(frame) != 480 {
		return -1
	}
	best, runner, total := 0.0, 0.0, 0.0
	symbol := -1
	for _, sample := range frame {
		total += float64(sample) * float64(sample)
	}
	if total < 480*1000*1000 {
		return -1
	}
	for index, freq := range tones {
		coefficient := 2 * math.Cos(2*math.Pi*freq/24000)
		previous, before := 0.0, 0.0
		for _, sample := range frame {
			value := float64(sample) + coefficient*previous - before
			before, previous = previous, value
		}
		power := previous*previous + before*before - coefficient*previous*before
		if power > best {
			runner, best, symbol = best, power, index
			continue
		}
		if power > runner {
			runner = power
		}
	}
	if best < runner*5 || best < total*60 {
		return -1
	}
	return symbol
}

func (s *signature) consume(frame media.PCM16Sample) bool {
	if s.done {
		return false
	}
	symbol := classify(frame)
	if symbol < 0 {
		s.blank++
		s.streak = 0
		if s.blank > 2 {
			s.stage = 0
			s.first = time.Time{}
		}
		return false
	}
	s.blank = 0
	if symbol != s.last {
		s.last = symbol
		s.streak = 1
		return false
	}
	s.streak++
	if s.streak != 2 {
		return false
	}
	if s.stage > 0 && symbol == s.order[s.stage-1] {
		return false
	}
	if symbol != s.order[s.stage] {
		s.stage = 0
		s.first = time.Time{}
		if symbol == s.order[0] {
			s.stage = 1
			s.first = time.Now()
		}
		return false
	}
	s.stage++
	if s.stage == 1 {
		s.first = time.Now()
	}
	if s.stage != len(s.order) {
		return false
	}
	s.done = true
	return true
}

type signal struct {
	mu      sync.Mutex
	current *signature
	matched chan recognition
}

type recognition struct{ first, time time.Time }

func (s *signal) arm(order [8]int) <-chan recognition {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.current = &signature{order: order, last: -1}
	s.matched = make(chan recognition, 1)
	return s.matched
}

func (s *signal) feed(frame media.PCM16Sample) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.current != nil && s.current.consume(frame) {
		s.matched <- recognition{first: s.current.first, time: time.Now()}
	}
}

func (s *signal) clear() { s.mu.Lock(); s.current = nil; s.mu.Unlock() }

type waveform struct{ write func(media.PCM16Sample) error }

func (*waveform) String() string  { return "synthetic-pcm-marker" }
func (*waveform) SampleRate() int { return 24000 }
func (*waveform) Close() error    { return nil }
func (w *waveform) WriteSample(frame media.PCM16Sample) error {
	if len(frame) != 480 {
		return errors.New("actual decoded marker changed mono 20ms shape")
	}
	return w.write(frame)
}

// This exercises the exact detector through actual lossy native libopus, rather
// than validating a detector with a duplicate or byte-equality implementation.
func TestPCMMarkerActualOpusCorrelation(t *testing.T) {
	reordered := watermark(17)
	reordered[2], reordered[3] = reordered[3], reordered[2]
	cases := []struct {
		name    string
		order   [8]int
		limit   int
		silence bool
		want    bool
	}{
		{"prior", watermark(16), 8, false, false},
		{"reordered", reordered, 8, false, false},
		{"incomplete", watermark(17), 7, false, false},
		{"silence", watermark(17), 8, true, false},
	}
	for id := 0; id < 18; id++ {
		cases = append(cases, struct {
			name    string
			order   [8]int
			limit   int
			silence bool
			want    bool
		}{fmt.Sprintf("exact-%d", id), watermark(id), 8, false, true})
	}
	for _, value := range cases {
		t.Run(value.name, func(t *testing.T) {
			target := watermark(17)
			if value.want {
				target = value.order
			}
			matcher := &signature{order: target, last: -1}
			matched := false
			decoder, err := opus.Decode(&waveform{write: func(frame media.PCM16Sample) error {
				if matcher.consume(frame) {
					matched = true
				}
				return nil
			}}, 1, logger.GetLogger())
			if err != nil {
				t.Fatal(err)
			}
			defer decoder.Close()
			output := &encoded{}
			encoder, err := opus.Encode(output, 1, logger.GetLogger())
			if err != nil {
				t.Fatal(err)
			}
			defer encoder.Close()
			for index := 0; index < 8+value.limit*4+8; index++ {
				symbol := -1
				if !value.silence && index >= 8 && index < 8+value.limit*4 {
					symbol = value.order[(index-8)/4]
				}
				output.packet = nil
				if err := encoder.WriteSample(tone(symbol)); err != nil {
					t.Fatal(err)
				}
				if err := decoder.WriteSample(opus.Sample(output.packet)); err != nil {
					t.Fatal(err)
				}
			}
			if matched != value.want {
				t.Fatalf("actual Opus marker correlation=%t expected=%t", matched, value.want)
			}
		})
	}
	seen := map[[8]int]bool{}
	for id := 0; id < 18; id++ {
		order := watermark(id)
		if seen[order] {
			t.Fatal("trial signatures are not distinct")
		}
		seen[order] = true
	}
}

type acquisition struct {
	Session      int       `json:"session"`
	Trial        int       `json:"trial"`
	Direction    string    `json:"direction"`
	Signature    [8]int    `json:"signature"`
	Start        time.Time `json:"start"`
	Detected     time.Time `json:"detected"`
	Milliseconds float64   `json:"signalAcquisitionMs"`
	First        time.Time `json:"firstToneConfirmed"`
	Confirmation float64   `json:"firstToneConfirmationMs"`
}

func TestProductionWorkerActualSFUPCMSignalAcquisition(t *testing.T) {
	path, url, key, secret := environment(t)
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal("cannot fingerprint production binary", err)
	}
	hash := sha256.Sum256(body)
	measurements := make([]acquisition, 0, 18)
	var attempted, sessions, joined, retired int
	defer func() {
		result := struct {
			Version           int                `json:"version"`
			Binary            string             `json:"binarySha256"`
			Completed         bool               `json:"completed"`
			Scope             string             `json:"scope"`
			MarkerMS          int                `json:"markerDurationMs"`
			Confidence        int                `json:"consecutiveFramesPerSymbol"`
			GuardMS           int                `json:"excludedGuardMs"`
			Measurements      []acquisition      `json:"rawMeasurements"`
			Distributions     map[string]latency `json:"signalAcquisition"`
			First             map[string]latency `json:"firstToneConfirmation"`
			AttemptedSessions int                `json:"attemptedSessions"`
			AttemptedTrials   int                `json:"attemptedTrials"`
			Joined            int                `json:"joinedSessions"`
			Retired           int                `json:"actualWaitRetiredSessions"`
		}{1, hex.EncodeToString(hash[:]), !t.Failed() && len(measurements) == 18 && joined == 3 && retired == 3, "correlated guard-warmed PCM signal acquisition including native codec and ordered-marker recognition delay, not cold first audio, frame/packet latency or audible playback; first marker tone submit to exact signature completion; client direction includes source encode; setup and 160ms silence guard excluded; first tone timestamp accepted only after entire current unique signature validates", 640, 2, 160, measurements, map[string]latency{}, map[string]latency{}, sessions, attempted, joined, retired}
		for _, direction := range []string{"child-publish-to-client-decoded-pcm", "client-opus-rtp-to-child-decoded-input"} {
			values := []time.Duration{}
			first := []time.Duration{}
			for _, value := range measurements {
				if value.Direction == direction {
					values = append(values, value.Detected.Sub(value.Start))
					first = append(first, value.First.Sub(value.Start))
				}
			}
			result.Distributions[direction] = distribution(values)
			result.First[direction] = distribution(first)
		}
		data, err := json.Marshal(result)
		if err != nil {
			t.Error(err)
			return
		}
		t.Logf("pcm_acquisition_measurement %s", data)
	}()
	for session := 0; session < 3; session++ {
		sessions++
		func() {
			lifetime, stop := context.WithCancel(ctx)
			defer stop()
			id := fmt.Sprintf("rvs_pcm_%d_%d", time.Now().UnixNano(), session)
			name, client, owner := "raya-"+id, "client-"+id, "media-"+id
			token := func(identity string) string {
				value, err := auth.NewAccessToken(key, secret).SetIdentity(identity).SetValidFor(3 * time.Minute).SetVideoGrant(&auth.VideoGrant{RoomJoin: true, Room: name}).ToJWT()
				if err != nil {
					t.Fatal("synthetic token creation failed")
				}
				return value
			}
			var outgoing, incoming signal
			fault := make(chan error, 1)
			fail := func(err error) {
				select {
				case fault <- err:
				default:
				}
			}
			var admission sync.Mutex
			sealed := false
			var readers sync.WaitGroup
			peer := lksdk.NewRoom(&lksdk.RoomCallback{ParticipantCallback: lksdk.ParticipantCallback{
				OnTrackSubscribed: func(track *webrtc.TrackRemote, pub *lksdk.RemoteTrackPublication, participant *lksdk.RemoteParticipant) {
					if participant.Identity() != owner || pub.Source() != lkproto.TrackSource_MICROPHONE {
						return
					}
					admission.Lock()
					if sealed || lifetime.Err() != nil {
						admission.Unlock()
						return
					}
					readers.Add(1)
					admission.Unlock()
					go func() {
						defer readers.Done()
						decoder, err := opus.Decode(&waveform{write: func(frame media.PCM16Sample) error { outgoing.feed(frame); return nil }}, 1, logger.GetLogger())
						if err != nil {
							fail(err)
							return
						}
						defer decoder.Close()
						watch := context.AfterFunc(lifetime, func() { _ = track.SetReadDeadline(time.Now()) })
						defer watch()
						for {
							packet, _, err := track.ReadRTP()
							if err != nil {
								if lifetime.Err() == nil {
									fail(errors.New("actual output RTP ended before trial completion"))
								}
								return
							}
							if packet.Padding && packet.PaddingSize > 0 && len(packet.Payload) == 0 {
								continue
							}
							if len(packet.Payload) == 0 || len(packet.Payload) > 1275 {
								fail(errors.New("invalid actual output Opus payload"))
								return
							}
							if err := decoder.WriteSample(opus.Sample(packet.Payload)); err != nil {
								fail(err)
								return
							}
						}
					}()
				},
				OnTrackUnsubscribed: func(track *webrtc.TrackRemote, _ *lksdk.RemoteTrackPublication, _ *lksdk.RemoteParticipant) {
					_ = track.SetReadDeadline(time.Now())
				},
			}})
			disconnected := make(chan struct{})
			cleanup := make(chan error, 1)
			go func() {
				defer close(disconnected)
				<-lifetime.Done()
				admission.Lock()
				sealed = true
				admission.Unlock()
				var failure error
				// Pion Close stops transceivers before transports; Unbind can wait
				// on WriteRTP's read lock. Stop the public ICE transport first so
				// an admitted network write can exit before SDK track teardown.
				for _, pc := range []*webrtc.PeerConnection{peer.LocalParticipant.GetPublisherPeerConnection(), peer.LocalParticipant.GetSubscriberPeerConnection()} {
					if pc != nil && pc.SCTP() != nil && pc.SCTP().Transport() != nil && pc.SCTP().Transport().ICETransport() != nil {
						if err := pc.SCTP().Transport().ICETransport().Stop(); err != nil {
							failure = errors.Join(failure, errors.New("synthetic observer transport stop failed"))
						}
					}
				}
				peer.Disconnect()
				readers.Wait()
				cleanup <- failure
			}()
			defer func() {
				stop()
				select {
				case <-disconnected:
					if err := <-cleanup; err != nil {
						t.Error(err)
					}
				case <-time.After(4 * time.Second):
					t.Error("PCM observer transport cleanup is unknown; retained owner did not join")
				}
			}()
			if err := peer.JoinWithContextAndToken(lifetime, url, token(client)); err != nil {
				t.Fatal("actual client SFU join failed", err)
			}
			transport, err := (Factory{Path: path}).JoinAudioAuthorized(lifetime, url, token(owner), name, client, 24000)
			if err != nil {
				stop()
				var setup *room.SetupError
				if errors.As(err, &setup) && setup.Cleanup != nil {
					select {
					case <-setup.Cleanup.Done():
						if err := setup.Cleanup.Err(); err != nil {
							t.Error("failed child setup cleanup remains unknown", err)
						}
					case <-time.After(4 * time.Second):
						t.Error("failed child setup did not reach actual cleanup receipt")
					}
				}
				t.Fatal("actual child SFU join failed", err)
			}
			proxy := transport.(*Proxy)
			joined++
			defer func() { stop(); _ = proxy.Close(); terminated(t, proxy); retired++ }()
			inputend := make(chan struct{})
			go func() {
				defer close(inputend)
				for {
					select {
					case <-lifetime.Done():
						return
					case <-proxy.Done():
						return
					case frame := <-proxy.Input():
						if frame.Rate != 24000 || len(frame.PCM) != 960 {
							fail(errors.New("actual input changed 20ms mono PCM shape"))
							return
						}
						sample := make(media.PCM16Sample, 480)
						for index := range sample {
							sample[index] = int16(binary.LittleEndian.Uint16(frame.PCM[index*2:]))
						}
						incoming.feed(sample)
					}
				}
			}()
			defer func() {
				stop()
				select {
				case <-inputend:
				case <-time.After(time.Second):
					t.Error("PCM input drain did not join")
				}
			}()
			track, err := lksdk.NewLocalTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := peer.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: "pcm-synthetic", Source: lkproto.TrackSource_MICROPHONE, DisableDTX: true}); err != nil {
				t.Fatal(err)
			}
			for !track.IsBound() {
				select {
				case <-lifetime.Done():
					t.Fatal("synthetic microphone did not bind")
				case <-time.After(10 * time.Millisecond):
				}
			}
			output := &encoded{}
			encoder, err := opus.Encode(output, 1, logger.GetLogger())
			if err != nil {
				t.Fatal(err)
			}
			type emission struct {
				frame   media.PCM16Sample
				seq     uint64
				expires time.Time
			}
			jobs := make(chan emission)
			acks := make(chan error, 1)
			producerend := make(chan struct{})
			producererr := make(chan error, 1)
			go func() {
				defer close(producerend)
				defer func() {
					err := encoder.Close()
					if err != nil {
						err = errors.New("synthetic source codec cleanup failed")
					}
					producererr <- err
				}()
				for {
					select {
					case <-lifetime.Done():
						return
					case job := <-jobs:
						if lifetime.Err() != nil || !job.expires.After(time.Now()) {
							acks <- context.DeadlineExceeded
							continue
						}
						output.packet = nil
						err := encoder.WriteSample(job.frame)
						if err == nil {
							if lifetime.Err() != nil || !job.expires.After(time.Now()) {
								err = context.DeadlineExceeded
							} else {
								err = track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: uint16(job.seq), Timestamp: uint32(job.seq * 960)}, Payload: output.packet}, nil)
							}
						}
						acks <- err
					}
				}
			}()
			defer func() {
				stop()
				select {
				case <-producerend:
					if err := <-producererr; err != nil {
						t.Error(err)
					}
				case <-time.After(4 * time.Second):
					t.Error("PCM producer cleanup is unknown; admitted write owner did not join")
				}
			}()
			write := func(frame media.PCM16Sample, seq uint64) error {
				call, finish := context.WithTimeout(lifetime, engine.FramePeriod)
				defer finish()
				expires, _ := call.Deadline()
				select {
				case jobs <- emission{frame, seq, expires}:
				case <-call.Done():
					return call.Err()
				}
				select {
				case err := <-acks:
					if call.Err() != nil {
						stop()
						return errors.New("synthetic microphone write outcome unknown after deadline")
					}
					return err
				case <-call.Done():
					stop()
					return errors.New("synthetic microphone write outcome unknown after deadline")
				}
			}
			sequence := uint64(0)
			for trial := 0; trial < 3; trial++ {
				for lane := 0; lane < 2; lane++ {
					attempted++
					order := watermark(session*6 + trial*2 + lane)
					matcher := &outgoing
					direction := "child-publish-to-client-decoded-pcm"
					if lane == 1 {
						matcher = &incoming
						direction = "client-opus-rtp-to-child-decoded-input"
					}
					matched := matcher.arm(order)
					var started time.Time
					tick := time.NewTicker(engine.FramePeriod)
					for frame := 0; frame < 48; frame++ {
						select {
						case <-lifetime.Done():
							tick.Stop()
							t.Fatal("PCM journey exceeded bounded deadline")
						case err := <-fault:
							tick.Stop()
							t.Fatal("actual PCM observer failed", err)
						case <-proxy.Failure():
							tick.Stop()
							t.Fatal("production child failed during PCM trial")
						case <-tick.C:
						}
						symbol := -1
						if frame >= 8 && frame < 40 {
							symbol = order[(frame-8)/4]
						}
						input, pcm := tone(-1), make([]byte, 960)
						if lane == 1 {
							input = tone(symbol)
						}
						if lane == 0 {
							for index, sample := range tone(symbol) {
								binary.LittleEndian.PutUint16(pcm[index*2:], uint16(sample))
							}
						}
						if lane == 1 && frame == 8 {
							started = time.Now()
							t.Logf("pcm_acquisition_begin session=%d trial=%d direction=%s signature=%v start=%s", session, trial, direction, order, started.UTC().Format(time.RFC3339Nano))
						}
						sequence++
						if err := write(input, sequence); err != nil {
							tick.Stop()
							t.Fatal("actual microphone RTP send failed", err)
						}
						if lane == 0 && frame == 8 {
							started = time.Now()
							t.Logf("pcm_acquisition_begin session=%d trial=%d direction=%s signature=%v start=%s", session, trial, direction, order, started.UTC().Format(time.RFC3339Nano))
						}
						if err := proxy.Publish(lifetime, engine.Frame{Rate: 24000, PCM: pcm}); err != nil {
							tick.Stop()
							t.Fatal("production PCM send failed", err)
						}
					}
					tick.Stop()
					select {
					case detected := <-matched:
						if !detected.time.After(started) || !detected.first.After(started) || detected.first.After(detected.time) {
							t.Fatal("PCM detection did not follow current marker start")
						}
						value := acquisition{session, trial, direction, order, started, detected.time, float64(detected.time.Sub(started)) / float64(time.Millisecond), detected.first, float64(detected.first.Sub(started)) / float64(time.Millisecond)}
						measurements = append(measurements, value)
						data, err := json.Marshal(value)
						if err != nil {
							t.Fatal(err)
						}
						t.Logf("pcm_acquisition_sample %s", data)
					case err := <-fault:
						t.Fatal("actual PCM observer failed", err)
					case <-time.After(2 * time.Second):
						t.Fatal("entire exact PCM signature was not observed; trial not retried or excluded")
					}
					matcher.clear()
				}
			}
			select {
			case err := <-fault:
				t.Fatal("actual PCM observer failed", err)
			default:
			}
		}()
	}
	if len(measurements) != 18 {
		t.Fatal("PCM journey missing required sessions or trials")
	}
}
