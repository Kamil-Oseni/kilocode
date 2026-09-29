//go:build linux && cgo

package process

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
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

type cohortLane struct {
	PID       int     `json:"pid"`
	Start     uint64  `json:"startTicks"`
	Ready     float64 `json:"readySeconds"`
	Input     uint64  `json:"inputFrames"`
	Output    uint64  `json:"outputFrames"`
	Controls  uint64  `json:"controls"`
	Published uint64  `json:"published"`
}

type cohortWindow struct {
	window
	Lanes []cohortLane `json:"lanes"`
}

type cohortRetirement struct {
	retirement
	Exit exit       `json:"exit"`
	Lane cohortLane `json:"lane"`
}

type cohortReport struct {
	Version     int     `json:"version"`
	Mode        string  `json:"mode"`
	Workers     int     `json:"workers"`
	Seconds     int     `json:"configuredSeconds"`
	Elapsed     float64 `json:"elapsedSeconds"`
	Active      float64 `json:"activeSeconds"`
	CommonReady float64 `json:"commonReadySeconds"`
	CommonStop  float64 `json:"commonStopSeconds"`
	Binary      string  `json:"binarySha256"`
	Scope       string  `json:"scope"`
	Attempted   int     `json:"attemptedWorkers"`
	Ready       int     `json:"readyWorkers"`
	Ninth       struct {
		Refused bool `json:"refused"`
		Before  int  `json:"beforeSlots"`
		After   int  `json:"afterSlots"`
	} `json:"ninth"`
	Windows     []cohortWindow     `json:"rawWindows"`
	Retirements []cohortRetirement `json:"retirements"`
	Completed   bool               `json:"completed"`
}

// A lane retains each actual SDK observer, one synchronous source/publish actor,
// its decoded-input drain and every admitted output decoder until joined.
type cohortOwner struct {
	proxy     *Proxy
	peer      *lksdk.Room
	stop      context.CancelFunc
	readers   sync.WaitGroup
	admission sync.Mutex
	closing   bool
	decoder   bool
	ended     chan struct{}
	cleanup   chan error
	actor     chan struct{}
	drain     chan struct{}
	ready     time.Time
	pid       int
	start     uint64
	input     atomic.Uint64
	output    atomic.Uint64
	controls  atomic.Uint64
	published atomic.Uint64
	expected  atomic.Value
	delivered atomic.Bool
}

func (o *cohortOwner) snapshot(started time.Time) cohortLane {
	ready := 0.0
	if !o.ready.IsZero() {
		ready = o.ready.Sub(started).Seconds()
	}
	return cohortLane{o.pid, o.start, ready, o.input.Load(), o.output.Load(), o.controls.Load(), o.published.Load()}
}

// This is transport-only synthetic load: eight independent authorized sessions,
// full-duplex real Opus/SFU/production children, not paid provider/device audio.
func TestProductionWorkersSustainedJointResources(t *testing.T) {
	seconds, enabled, err := cohortConfig(os.Getenv("RAYA_TEST_RESOURCE_WORKERS"), os.Getenv("RAYA_TEST_RESOURCE_SECONDS"))
	if err != nil {
		t.Fatal(err)
	}
	if !enabled {
		t.Skip("requires explicit eight-worker resource gate")
	}
	report := os.Getenv("RAYA_TEST_RESOURCE_REPORT")
	if report != "" && !filepath.IsAbs(report) {
		t.Fatal("cohort report requires an absolute path")
	}
	path, url, key, secret := environment(t)
	if len(slots) != 0 {
		t.Fatal("cohort scope already has owned workers")
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal("cohort binary fingerprint unavailable")
	}
	hash := sha256.Sum256(body)
	body = nil
	parent, err := identity(os.Getpid())
	if err != nil {
		t.Fatal("cohort parent identity unavailable")
	}
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(seconds+180)*time.Second)
	defer cancel()
	var boundary atomic.Int64
	fence := func() {
		at := time.Now()
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			at, _ = ctx.Deadline()
		}
		boundary.CompareAndSwap(0, at.Sub(started).Nanoseconds())
		cancel()
	}
	result := cohortReport{Version: 1, Mode: "cohort", Workers: 8, Seconds: seconds, Binary: hex.EncodeToString(hash[:]), Scope: "owned PSS=Go test parent including eight synthetic SDK observers and retained report plus all active/retiring production children; local SFU excluded; cgroup includes tool processes; no provider/device/acoustic or plateau claim", Windows: make([]cohortWindow, 0, seconds+4)}
	owners := make([]*cohortOwner, 0, 8)
	fault := make(chan error, 8)
	fail := func(message string) {
		select {
		case fault <- errors.New(message):
		default:
		}
		fence()
	}
	var shutdown sync.Once
	var active time.Time
	record := func(phase string) error {
		parent, err := observe(os.Getpid(), parent)
		if err != nil {
			return errors.New("cohort parent resource observation failed")
		}
		entry := cohortWindow{window: window{Seconds: time.Since(started).Seconds(), Phase: phase, Slots: len(slots), Parent: parent, OwnedPSS: parent.PSS, Group: group()}}
		var stats runtime.MemStats
		runtime.ReadMemStats(&stats)
		entry.Runtime = &heap{Alloc: stats.HeapAlloc, Inuse: stats.HeapInuse, Sys: stats.HeapSys, GC: stats.NumGC, Goroutines: runtime.NumGoroutine()}
		if phase != "retired" {
			for _, owner := range owners {
				child, err := observe(owner.pid, owner.start)
				if err != nil {
					data, encoding := json.Marshal(struct {
						PID      int               `json:"pid"`
						Expected uint64            `json:"expectedStartTicks"`
						Position proc              `json:"position"`
						Group    map[string]string `json:"cgroup"`
					}{owner.pid, owner.start, position(owner.pid), group()})
					if encoding == nil {
						t.Logf("cohort_failed_observation %s", data)
					}
					return errors.New("cohort exact child resource observation failed")
				}
				entry.Children = append(entry.Children, child)
				entry.Lanes = append(entry.Lanes, owner.snapshot(started))
				entry.OwnedPSS += child.PSS
			}
		}
		if entry.Slots != len(entry.Children) {
			return errors.New("cohort slots disagree with all retained children")
		}
		result.Windows = append(result.Windows, entry)
		data, err := json.Marshal(entry)
		if err != nil {
			return errors.New("cohort sample encoding failed")
		}
		t.Logf("cohort_resource_sample %s", data)
		return nil
	}
	stop := func() {
		shutdown.Do(func() {
			fence() // One common cancellation fences all eight lanes.
			result.CommonStop = float64(boundary.Load()) / float64(time.Second)
			if !active.IsZero() {
				result.Active = result.CommonStop - result.CommonReady
			}
			for _, owner := range owners {
				owner.stop()
			}
			deadline, end := context.WithTimeout(context.Background(), 4*time.Second)
			defer end()
			for _, owner := range owners {
				if owner.proxy != nil {
					select {
					case <-owner.proxy.Done():
						absent := errors.Is(syscall.Kill(owner.pid, 0), syscall.ESRCH)
						value := owner.proxy.outcome()
						if !absent || !value.Known || owner.proxy.Err() != nil {
							t.Error("cohort child lacks exact Wait/PID-absence receipt")
						}
						duration := 0.0
						if !owner.ready.IsZero() {
							duration = result.CommonStop - owner.ready.Sub(started).Seconds()
						}
						result.Retirements = append(result.Retirements, cohortRetirement{retirement: retirement{PID: owner.pid, Start: owner.start, Seconds: time.Since(started).Seconds(), Wait: value.Known, Absent: absent, Ready: owner.snapshot(started).Ready, Active: duration}, Exit: value, Lane: owner.snapshot(started)})
					case <-deadline.Done():
						t.Error("cohort joint retirement exceeded bounded wait")
					}
				}
			}
			for _, owner := range owners {
				for _, end := range []<-chan struct{}{owner.ended, owner.actor, owner.drain} {
					if end == nil {
						continue
					}
					select {
					case <-end:
					case <-deadline.Done():
						t.Error("cohort parent actor/decoder/transport ownership remains unknown")
					}
				}
				select {
				case err := <-owner.cleanup:
					if err != nil {
						t.Error(err)
					}
				case <-deadline.Done():
					t.Error("cohort observer cleanup receipt remains unknown")
				}
			}
			if len(slots) != 0 {
				t.Error("cohort retained slot after real joint retirement")
			}
			if err := record("retired"); err != nil {
				t.Error(err)
			}
		})
	}
	defer func() {
		stop()
		result.Elapsed = time.Since(started).Seconds()
		result.Completed = !t.Failed() && result.Ready == 8 && len(result.Retirements) == 8 && result.Ninth.Refused && result.Active >= float64(seconds) && len(slots) == 0
		data, err := json.Marshal(result)
		if err != nil {
			t.Error("cohort report encoding failed")
			return
		}
		t.Logf("cohort_resource_measurement %s", data)
		if report != "" {
			if err := os.WriteFile(report, data, 0644); err != nil {
				t.Error("cohort report write failed")
			}
		}
	}()
	packet := &encoded{}
	codec, err := opus.Encode(packet, 1, logger.GetLogger())
	if err != nil {
		t.Fatal("actual cohort source codec unavailable")
	}
	frame := tone(0)
	if err := codec.WriteSample(frame); err != nil {
		_ = codec.Close()
		t.Fatal("actual cohort source encoding failed")
	}
	if err := codec.Close(); err != nil {
		t.Fatal("actual cohort source codec cleanup failed")
	}
	pcm := make([]byte, 960)
	for index, sample := range frame {
		binary.LittleEndian.PutUint16(pcm[index*2:], uint16(sample))
	}
	for index := 0; index < 8; index++ {
		result.Attempted++
		lifetime, finish := context.WithCancel(ctx)
		owner := &cohortOwner{stop: finish, ended: make(chan struct{}), cleanup: make(chan error, 1)}
		owner.expected.Store("")
		owners = append(owners, owner)
		id := fmt.Sprintf("rvs_cohort_%d_%d", started.UnixNano(), index)
		name, client, remote := "raya-"+id, "client-"+id, "media-"+id
		token := func(identity string) string {
			value, err := auth.NewAccessToken(key, secret).SetIdentity(identity).SetValidFor(time.Hour).SetVideoGrant(&auth.VideoGrant{RoomJoin: true, Room: name}).ToJWT()
			if err != nil {
				t.Fatal("cohort synthetic token creation failed")
			}
			return value
		}
		owner.peer = lksdk.NewRoom(&lksdk.RoomCallback{ParticipantCallback: lksdk.ParticipantCallback{
			OnTrackSubscribed: func(track *webrtc.TrackRemote, pub *lksdk.RemoteTrackPublication, participant *lksdk.RemoteParticipant) {
				if participant == nil || participant.Identity() != remote || pub.Source() != lkproto.TrackSource_MICROPHONE {
					return
				}
				owner.admission.Lock()
				if owner.closing || lifetime.Err() != nil {
					owner.admission.Unlock()
					return
				}
				if owner.decoder {
					owner.admission.Unlock()
					fail("cohort unexpected additional output decoder")
					return
				}
				owner.decoder = true
				owner.readers.Add(1)
				owner.admission.Unlock()
				go func() {
					defer owner.readers.Done()
					decoder, err := opus.Decode(&waveform{write: func(sample media.PCM16Sample) error {
						if lifetime.Err() != nil {
							return nil
						}
						for _, value := range sample {
							if value != 0 {
								owner.output.Add(1)
								break
							}
						}
						return nil
					}}, 1, logger.GetLogger())
					if err != nil {
						fail("cohort actual output decoder unavailable")
						return
					}
					defer func() {
						if err := decoder.Close(); err != nil {
							fail("cohort output decoder cleanup failed")
						}
					}()
					watch := context.AfterFunc(lifetime, func() { _ = track.SetReadDeadline(time.Now()) })
					defer watch()
					for {
						packet, _, err := track.ReadRTP()
						if err != nil {
							if lifetime.Err() == nil {
								fail("cohort output RTP ended before Stop")
							}
							return
						}
						if packet.Padding && packet.PaddingSize > 0 && len(packet.Payload) == 0 {
							continue
						}
						if len(packet.Payload) == 0 || len(packet.Payload) > 1275 {
							fail("cohort malformed output RTP")
							return
						}
						if err := decoder.WriteSample(opus.Sample(packet.Payload)); err != nil {
							fail("cohort output decode failed")
							return
						}
					}
				}()
			},
			OnTrackUnsubscribed: func(track *webrtc.TrackRemote, _ *lksdk.RemoteTrackPublication, _ *lksdk.RemoteParticipant) {
				_ = track.SetReadDeadline(time.Now())
			},
			OnDataPacket: func(packet lksdk.DataPacket, params lksdk.DataReceiveParams) {
				owner.admission.Lock()
				defer owner.admission.Unlock()
				if owner.closing || lifetime.Err() != nil {
					return
				}
				value, ok := packet.(*lksdk.UserDataPacket)
				if !ok || params.SenderIdentity != remote || value.Topic != "raya.cohort" {
					return
				}
				if string(value.Payload) != owner.expected.Load().(string) || owner.delivered.Swap(true) {
					fail("cohort control nonce changed or duplicated")
					return
				}
				owner.controls.Add(1)
			},
		}})
		go func() {
			defer close(owner.ended)
			<-lifetime.Done()
			owner.admission.Lock()
			owner.closing = true
			owner.admission.Unlock()
			var failure error
			for _, pc := range []*webrtc.PeerConnection{owner.peer.LocalParticipant.GetPublisherPeerConnection(), owner.peer.LocalParticipant.GetSubscriberPeerConnection()} {
				if pc != nil && pc.SCTP() != nil && pc.SCTP().Transport() != nil && pc.SCTP().Transport().ICETransport() != nil {
					if err := pc.SCTP().Transport().ICETransport().Stop(); err != nil {
						failure = errors.Join(failure, errors.New("cohort observer ICE cleanup failed"))
					}
				}
			}
			owner.peer.Disconnect()
			owner.readers.Wait()
			owner.cleanup <- failure
		}()
		if err := owner.peer.JoinWithContextAndToken(lifetime, url, token(client)); err != nil {
			t.Fatal("cohort actual observer join failed")
		}
		transport, err := (Factory{Path: path}).JoinAudioAuthorized(lifetime, url, token(remote), name, client, 24000)
		if err != nil {
			var setup *room.SetupError
			if errors.As(err, &setup) && setup.Cleanup != nil {
				if proxy, ok := setup.Cleanup.(*Proxy); ok {
					owner.proxy = proxy
					owner.pid = proxy.PID()
					owner.start, _ = identity(owner.pid)
				}
			}
			t.Fatal("cohort actual production child join failed")
		}
		owner.proxy = transport.(*Proxy)
		owner.pid = owner.proxy.PID()
		owner.start, err = identity(owner.pid)
		if err != nil {
			t.Fatal("cohort child starttime unavailable")
		}
		owner.ready = time.Now()
		result.Ready++
		owner.drain = make(chan struct{})
		go func() {
			defer close(owner.drain)
			for {
				select {
				case <-lifetime.Done():
					return
				case <-owner.proxy.Done():
					return
				case frame := <-owner.proxy.Input():
					if lifetime.Err() != nil {
						return
					}
					if frame.Rate != 24000 || len(frame.PCM) != 960 {
						fail("cohort actual microphone decode changed 20ms mono shape")
						return
					}
					for offset := 0; offset < len(frame.PCM); offset += 2 {
						if binary.LittleEndian.Uint16(frame.PCM[offset:]) != 0 {
							owner.input.Add(1)
							break
						}
					}
				}
			}
		}()
		track, err := lksdk.NewLocalTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2})
		if err != nil {
			t.Fatal("cohort synthetic track creation failed")
		}
		if _, err := owner.peer.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: "cohort-synthetic", Source: lkproto.TrackSource_MICROPHONE, DisableDTX: true}); err != nil {
			t.Fatal("cohort synthetic microphone publication failed")
		}
		for !track.IsBound() {
			select {
			case <-lifetime.Done():
				t.Fatal("cohort synthetic microphone binding failed")
			case <-time.After(10 * time.Millisecond):
			}
		}
		owner.actor = make(chan struct{})
		go func() {
			defer close(owner.actor)
			tick := time.NewTicker(engine.FramePeriod)
			defer tick.Stop()
			next := time.Now().Add(500 * time.Millisecond)
			for {
				select {
				case <-lifetime.Done():
					return
				case <-owner.proxy.Failure():
					fail("cohort production child failed")
					return
				case <-tick.C:
				}
				if lifetime.Err() != nil {
					return
				}
				seq := owner.published.Load() + 1
				if err := track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: uint16(seq), Timestamp: uint32(seq * 960)}, Payload: packet.packet}, nil); err != nil {
					if lifetime.Err() == nil {
						fail("cohort actual synthetic RTP write failed")
					}
					return
				}
				if lifetime.Err() != nil {
					return
				}
				if err := owner.proxy.Publish(lifetime, engine.Frame{Rate: 24000, PCM: pcm, Item: "cohort-output", Epoch: 1, Seq: seq, Start: (seq - 1) * 480, End: seq * 480, At: time.Now()}); err != nil {
					if lifetime.Err() == nil {
						fail("cohort PCM publication failed without replay")
					}
					return
				}
				owner.published.Store(seq)
				if time.Now().Before(next) {
					continue
				}
				if owner.expected.Load().(string) != "" && !owner.delivered.Load() {
					fail("cohort exact control delivery missing")
					return
				}
				body := fmt.Sprintf(`{"lane":%d,"sequence":%d}`, index, seq)
				owner.expected.Store(body)
				owner.delivered.Store(false)
				if err := owner.proxy.Send(lifetime, room.Data{Topic: "raya.cohort", Body: []byte(body)}); err != nil {
					if lifetime.Err() == nil {
						fail("cohort control publication failed without replay")
					}
					return
				}
				next = time.Now().Add(500 * time.Millisecond)
			}
		}()
	}
	if ctx.Err() != nil {
		t.Fatal("cohort setup lost a lane before common readiness")
	}
	active = time.Now()
	result.CommonReady = active.Sub(started).Seconds()
	for _, owner := range owners {
		if value, err := identity(owner.pid); err != nil || value != owner.start {
			t.Fatal("cohort identity changed before capacity refusal")
		}
	}
	result.Ninth.Before = len(slots)
	transport, err := (Factory{Path: path}).JoinAudioAuthorized(ctx, url, "capacity-test-token", "capacity-ninth", "client-rvs_cohort_ninth", 24000)
	result.Ninth.After = len(slots)
	result.Ninth.Refused = transport == nil && errors.Is(err, ErrCapacity) && result.Ninth.Before == 8 && result.Ninth.After == 8
	if !result.Ninth.Refused {
		t.Fatal("cohort ninth worker was not refused before process allocation")
	}
	for _, owner := range owners {
		if value, err := identity(owner.pid); err != nil || value != owner.start {
			t.Fatal("cohort identity changed during capacity refusal")
		}
	}
	if err := record("active"); err != nil {
		t.Fatal(err)
	}
	previous := make([]cohortLane, 8)
	for index, owner := range owners {
		previous[index] = owner.snapshot(started)
	}
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	until := active.Add(time.Duration(seconds) * time.Second)
	for time.Now().Before(until) {
		select {
		case <-ctx.Done():
			t.Fatal("cohort lifetime cancelled before configured interval")
		case err := <-fault:
			t.Fatal(err)
		case <-tick.C:
		}
		for index, owner := range owners {
			current := owner.snapshot(started)
			if time.Since(active) > 5*time.Second && (current.Input <= previous[index].Input || current.Output <= previous[index].Output || current.Controls <= previous[index].Controls || current.Published <= previous[index].Published) {
				t.Fatal("cohort per-lane full-duplex/control window stalled")
			}
			previous[index] = current
		}
		if err := record("active"); err != nil {
			t.Fatal(err)
		}
	}
	if err := record("retiring-admission"); err != nil {
		t.Fatal(err)
	}
	stop()
	select {
	case err := <-fault:
		t.Error(err)
	default:
	}
}
