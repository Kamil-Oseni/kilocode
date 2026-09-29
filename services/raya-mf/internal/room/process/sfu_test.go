//go:build cgo && !windows

// Actual production-binary child and local SFU/libopus test; no device/provider audio.
package process

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
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

type encoded struct{ packet []byte }

func (*encoded) String() string  { return "process-test-encoder" }
func (*encoded) SampleRate() int { return 24000 }
func (*encoded) Close() error    { return nil }
func (e *encoded) WriteSample(sample opus.Sample) error {
	if len(sample) == 0 || len(sample) > 1275 || e.packet != nil {
		return errors.New("invalid synthetic Opus output")
	}
	e.packet = append([]byte(nil), sample...)
	return nil
}

type decoded struct{ frames chan media.PCM16Sample }

func (*decoded) String() string  { return "process-test-decoder" }
func (*decoded) SampleRate() int { return 24000 }
func (*decoded) Close() error    { return nil }
func (d *decoded) WriteSample(sample media.PCM16Sample) error {
	if len(sample) != 480 {
		return errors.New("synthetic decoder changed 20 ms mono shape")
	}
	for _, value := range sample {
		if value == 0 {
			continue
		}
		select {
		case d.frames <- append(media.PCM16Sample(nil), sample...):
		default:
		}
		break
	}
	return nil
}

func environment(t *testing.T) (string, string, string, string) {
	t.Helper()
	path, raw := os.Getenv("RAYA_TEST_MEDIA_BINARY"), os.Getenv("RAYA_TEST_LIVEKIT_URL")
	if path == "" || raw == "" {
		t.Skip("requires explicit production RAYA_TEST_MEDIA_BINARY and local SFU environment")
	}
	info, err := os.Stat(path)
	if err != nil || !filepath.IsAbs(path) || info.IsDir() || info.Mode()&0111 == 0 {
		t.Fatal("production media binary must be an absolute executable path")
	}
	uri, err := url.Parse(raw)
	if err != nil || uri.User != nil || uri.RawQuery != "" || uri.Fragment != "" || (uri.Scheme != "http" && uri.Scheme != "ws") || (uri.Hostname() != "localhost" && !net.ParseIP(uri.Hostname()).IsLoopback()) {
		t.Fatal("process SFU test requires a loopback-only URL")
	}
	key, secret := os.Getenv("RAYA_TEST_LIVEKIT_KEY"), os.Getenv("RAYA_TEST_LIVEKIT_SECRET")
	if key == "" || secret == "" {
		t.Fatal("explicit test SFU credentials are required")
	}
	return path, raw, key, secret
}

func terminated(t *testing.T, owner *Proxy) {
	t.Helper()
	pid := owner.PID()
	if pid <= 0 || pid == os.Getpid() {
		t.Fatal("production worker had no distinct real PID")
	}
	select {
	case <-owner.Done():
	case <-time.After(4 * time.Second):
		t.Fatal("production worker did not reach actual Wait termination")
	}
	if err := owner.Err(); err != nil {
		t.Fatal("production worker cleanup failed", err)
	}
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("worker PID %d remains observable after Wait: %v", pid, err)
	}
}

func TestProductionWorkerSFUPCMControlAndActualTermination(t *testing.T) {
	path, raw, key, secret := environment(t)
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	id := "rvs_process_" + strings.ReplaceAll(time.Now().UTC().Format("150405.000000000"), ".", "")
	name, client, owner := "raya-test-"+id, "client-"+id, "media-"+id
	token := func(identity string) string {
		t.Helper()
		value, err := auth.NewAccessToken(key, secret).SetIdentity(identity).SetValidFor(time.Minute).SetVideoGrant(&auth.VideoGrant{RoomJoin: true, Room: name}).ToJWT()
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	frames := &decoded{frames: make(chan media.PCM16Sample, 1)}
	started, ended := make(chan struct{}), make(chan struct{})
	failures := make(chan error, 4)
	data := make(chan room.Data, 16)
	var once sync.Once
	peer := lksdk.NewRoom(&lksdk.RoomCallback{ParticipantCallback: lksdk.ParticipantCallback{
		OnTrackSubscribed: func(track *webrtc.TrackRemote, publication *lksdk.RemoteTrackPublication, participant *lksdk.RemoteParticipant) {
			if participant.Identity() != owner || publication.Source() != lkproto.TrackSource_MICROPHONE {
				return
			}
			once.Do(func() {
				close(started)
				go func() {
					defer close(ended)
					codec, err := opus.Decode(frames, 1, logger.GetLogger())
					if err != nil {
						failures <- err
						return
					}
					defer codec.Close()
					stop := context.AfterFunc(ctx, func() { _ = track.SetReadDeadline(time.Now()) })
					defer stop()
					deadline, _ := ctx.Deadline()
					_ = track.SetReadDeadline(deadline)
					for {
						packet, _, err := track.ReadRTP()
						if err != nil {
							if ctx.Err() == nil {
								failures <- err
							}
							return
						}
						if err := codec.WriteSample(packet.Payload); err != nil {
							failures <- err
							return
						}
					}
				}()
			})
		},
		OnDataPacket: func(packet lksdk.DataPacket, params lksdk.DataReceiveParams) {
			value, ok := packet.(*lksdk.UserDataPacket)
			if !ok || params.SenderIdentity != owner || (value.Topic != "raya.process-test" && value.Topic != "raya.transcript") {
				return
			}
			select {
			case data <- room.Data{Identity: params.SenderIdentity, Topic: value.Topic, Body: append([]byte(nil), value.Payload...)}:
			default:
			}
		},
	}})
	var proxy *Proxy
	t.Cleanup(func() {
		cancel()
		if proxy != nil {
			_ = proxy.Close()
			terminated(t, proxy)
		}
		done := make(chan struct{})
		go func() { peer.Disconnect(); close(done) }()
		select {
		case <-done:
		case <-time.After(4 * time.Second):
			t.Error("test SDK peer Disconnect blocked")
		}
		select {
		case <-started:
			select {
			case <-ended:
			case <-time.After(time.Second):
				t.Error("test PCM decoder remained active")
			}
		default:
		}
	})
	if err := peer.JoinWithContextAndToken(ctx, raw, token(client)); err != nil {
		t.Fatal(err)
	}
	joined, err := (Factory{Path: path}).JoinAudioAuthorized(ctx, raw, token(owner), name, client, 24000)
	if err != nil {
		t.Fatal("production binary could not join actual SFU", err)
	}
	var ok bool
	proxy, ok = joined.(*Proxy)
	if !ok {
		t.Fatal("Factory did not return production process proxy")
	}
	input := make(chan engine.Frame, 1)
	inputend := make(chan struct{})
	go func() {
		defer close(inputend)
		for {
			select {
			case <-ctx.Done():
				return
			case frame, ok := <-proxy.Input():
				if !ok {
					return
				}
				select {
				case input <- frame:
				default:
				}
			}
		}
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-inputend:
		case <-time.After(time.Second):
			t.Error("test proxy input consumer remained active")
		}
	})
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("production worker output did not subscribe")
	}
	if err := proxy.Send(ctx, room.Data{Topic: "raya.process-test", Body: []byte("exact-client")}); err != nil {
		t.Fatal(err)
	}
	select {
	case value := <-data:
		if value.Identity != owner || string(value.Body) != "exact-client" {
			t.Fatal("process control scope changed")
		}
	case <-ctx.Done():
		t.Fatal("process control never reached exact client")
	}
	large := bytes.Repeat([]byte("p"), 15*1024)
	if err := proxy.Send(ctx, room.Data{Topic: "raya.process-test", Body: large}); err != nil {
		t.Fatal("actual 15 KiB control Send failed", err)
	}
	select {
	case value := <-data:
		if value.Identity != owner || value.Topic != "raya.process-test" || !bytes.Equal(value.Body, large) {
			t.Fatal("actual 15 KiB control body or owner changed")
		}
	case <-ctx.Done():
		t.Fatal("actual 15 KiB control never reached the exact client")
	}
	playout := []byte(`{"version":3,"session":"` + id + `","item":"process-output","turn":"process-turn","epoch":1,"seq":1,"samples":480,"rate":24000,"jitterMs":0,"final":false}`)
	packet := lksdk.UserData(playout)
	packet.Topic = "raya.playout"
	if err := peer.LocalParticipant.PublishDataPacket(packet, lksdk.WithDataPublishReliable(true), lksdk.WithDataPublishDestination([]string{owner})); err != nil {
		t.Fatal("actual client playout publication failed", err)
	}
	select {
	case value := <-proxy.Data():
		if value.Identity != client || value.Topic != "raya.playout" || !bytes.Equal(value.Body, playout) {
			t.Fatal("actual process playout changed exact client/body")
		}
	case <-ctx.Done():
		t.Fatal("actual client playout did not reach process proxy")
	}
	track, err := lksdk.NewLocalTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2})
	if err != nil {
		t.Fatal(err)
	}
	publication, err := peer.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: "process-synthetic", Source: lkproto.TrackSource_MICROPHONE, DisableDTX: true})
	if err != nil {
		t.Fatal(err)
	}
	defer peer.LocalParticipant.UnpublishTrack(publication.SID())
	for !track.IsBound() {
		select {
		case <-ctx.Done():
			t.Fatal("synthetic input did not bind")
		case <-time.After(10 * time.Millisecond):
		}
	}
	output := &encoded{}
	codec, err := opus.Encode(output, 1, logger.GetLogger())
	if err != nil {
		t.Fatal(err)
	}
	defer codec.Close()
	tick := time.NewTicker(engine.FramePeriod)
	defer tick.Stop()
	captions := make([][]byte, 0, 6)
	for index := 0; index < 24; index++ {
		select {
		case <-ctx.Done():
			t.Fatal("process audio deadline")
		case <-tick.C:
		}
		sample := make(media.PCM16Sample, 480)
		pcm := make([]byte, 960)
		for offset := range sample {
			sample[offset] = int16(2000 * math.Sin(2*math.Pi*440*float64(index*480+offset)/24000))
			binary.LittleEndian.PutUint16(pcm[offset*2:], uint16(sample[offset]))
		}
		output.packet = nil
		if err := codec.WriteSample(sample); err != nil {
			t.Fatal(err)
		}
		if err := track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: uint16(index + 1), Timestamp: uint32(index * 960)}, Payload: output.packet}, nil); err != nil {
			t.Fatal(err)
		}
		if index%4 == 0 {
			body, err := json.Marshal(map[string]any{"type": "transcript.output.delta", "item": strings.Repeat("c", index+1), "text": "concurrent exact caption"})
			if err != nil {
				t.Fatal(err)
			}
			captions = append(captions, body)
			start := make(chan struct{})
			results := make(chan error, 2)
			go func() { <-start; results <- proxy.Publish(ctx, engine.Frame{Rate: 24000, PCM: pcm}) }()
			go func() { <-start; results <- proxy.Send(ctx, room.Data{Topic: "raya.transcript", Body: body}) }()
			close(start)
			for range 2 {
				select {
				case err := <-results:
					if err != nil {
						t.Fatal("actual concurrent audio/control request failed", err)
					}
				case <-ctx.Done():
					t.Fatal("actual concurrent audio/control did not settle")
				}
			}
			continue
		}
		if err := proxy.Publish(ctx, engine.Frame{Rate: 24000, PCM: pcm}); err != nil {
			t.Fatal(err)
		}
	}
	for _, body := range captions {
		select {
		case value := <-data:
			if value.Identity != owner || value.Topic != "raya.transcript" || !bytes.Equal(value.Body, body) {
				t.Fatal("concurrent actual transcript was changed, reordered, or duplicated")
			}
		case <-ctx.Done():
			t.Fatal("concurrent actual transcript never reached exact client")
		}
	}
	select {
	case <-data:
		t.Fatal("actual control/transcript effects were replayed")
	case <-time.After(80 * time.Millisecond):
	}
	select {
	case frame := <-input:
		if frame.Rate != 24000 || len(frame.PCM) != 960 {
			t.Fatal("actual child microphone changed native PCM shape")
		}
		signal := false
		for offset := 0; offset < len(frame.PCM); offset += 2 {
			if binary.LittleEndian.Uint16(frame.PCM[offset:]) != 0 {
				signal = true
				break
			}
		}
		if !signal {
			t.Fatal("actual child microphone has no decoded signal")
		}
	case err := <-failures:
		t.Fatal(err)
	case <-ctx.Done():
		t.Fatal("actual child microphone never reached proxy")
	}
	select {
	case <-frames.frames:
	case err := <-failures:
		t.Fatal(err)
	case <-ctx.Done():
		t.Fatal("actual process output never decoded at client")
	}
	if err := proxy.Flush(ctx, "synthetic"); err != nil {
		t.Fatal("actual process Flush failed", err)
	}
	if err := proxy.Close(); err != nil && !errors.Is(err, room.ErrCleanupUnknown) {
		t.Fatal(err)
	}
	terminated(t, proxy)
	if err := proxy.Close(); err != nil {
		t.Fatal("confirmed process close was not idempotent", err)
	}
	if err := proxy.Publish(ctx, engine.Frame{Rate: 24000, PCM: make([]byte, 960)}); err == nil {
		t.Fatal("terminated child accepted more audio")
	}
	failed, err := (Factory{Path: path}).JoinAudioAuthorized(ctx, raw, token("other-"+owner), name, client, 24000)
	var refusal *room.SetupError
	if failed != nil || !errors.As(err, &refusal) || refusal.Cleanup == nil {
		t.Fatal("actual SFU identity refusal lost worker owner", err)
	}
	rejected, ok := refusal.Cleanup.(*Proxy)
	if !ok {
		t.Fatal("refused worker lost actual PID receipt")
	}
	terminated(t, rejected)
}

func TestProductionWorkerCancelledNativeJoinActuallyExits(t *testing.T) {
	path, _, _, _ := environment(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			accepted <- conn
		}
	}()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	type result struct {
		media room.Room
		err   error
	}
	done := make(chan result, 1)
	go func() {
		media, err := (Factory{Path: path}).JoinAudioAuthorized(ctx, "ws://"+listener.Addr().String(), "test-held-handshake", "held-native-join", "client-rvs_held", 24000)
		done <- result{media, err}
	}()
	select {
	case conn := <-accepted:
		defer conn.Close()
	case <-time.After(4 * time.Second):
		t.Fatal("production worker never entered held native handshake")
	}
	cancel()
	select {
	case value := <-done:
		var failure *room.SetupError
		if value.media != nil || !errors.As(value.err, &failure) || failure.Cleanup == nil {
			t.Fatal("cancelled actual worker lost retained cleanup", value.err)
		}
		owner, ok := failure.Cleanup.(*Proxy)
		if !ok {
			t.Fatal("cancelled worker lost actual PID")
		}
		terminated(t, owner)
	case <-time.After(time.Second):
		t.Fatal("native Join cancellation did not return promptly")
	}
}

func TestProductionWorkerRepeatedSFUJoinsReapBeforeReplacement(t *testing.T) {
	path, raw, key, secret := environment(t)
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	var previous *Proxy
	for index := 0; index < 5; index++ {
		if previous != nil {
			terminated(t, previous)
		}
		id := "rvs_repeat_" + strings.ReplaceAll(time.Now().UTC().Format("150405.000000000"), ".", "")
		name, client := "raya-repeat-"+id, "client-"+id
		token, err := auth.NewAccessToken(key, secret).SetIdentity("media-" + id).SetValidFor(time.Minute).SetVideoGrant(&auth.VideoGrant{RoomJoin: true, Room: name}).ToJWT()
		if err != nil {
			t.Fatal(err)
		}
		joined, err := (Factory{Path: path}).JoinAudioAuthorized(ctx, raw, token, name, client, 24000)
		if err != nil {
			t.Fatalf("actual SFU repeat %d failed: %v", index, err)
		}
		owner, ok := joined.(*Proxy)
		if !ok {
			t.Fatal("repeat did not own real production child")
		}
		t.Cleanup(func() { _ = owner.Close(); terminated(t, owner) })
		if err := owner.Close(); err != nil && !errors.Is(err, room.ErrCleanupUnknown) {
			t.Fatal(err)
		}
		terminated(t, owner)
		previous = owner
	}
}

func TestProductionWorkerCapacityCountsActualBlockedChildrenUntilWait(t *testing.T) {
	path, _, _, _ := environment(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 9)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			accepted <- conn
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	type result struct {
		media room.Room
		err   error
	}
	results := make(chan result, 8)
	for index := 0; index < 8; index++ {
		client := "client-rvs_capacity_" + string(rune('a'+index))
		go func() {
			media, err := (Factory{Path: path}).JoinAudioAuthorized(ctx, "ws://"+listener.Addr().String(), "held-test-token", "capacity", client, 24000)
			results <- result{media, err}
		}()
		select {
		case conn := <-accepted:
			t.Cleanup(func() { _ = conn.Close() })
		case <-time.After(4 * time.Second):
			t.Fatal("actual production child did not enter blocked handshake")
		}
	}
	media, err := (Factory{Path: path}).JoinAudioAuthorized(ctx, "ws://"+listener.Addr().String(), "held-test-token", "capacity", "client-rvs_capacity_ninth", 24000)
	if media != nil || !errors.Is(err, ErrCapacity) {
		t.Fatal("ninth real worker was allocated", err)
	}
	select {
	case conn := <-accepted:
		_ = conn.Close()
		t.Fatal("refused ninth worker entered native handshake")
	case <-time.After(80 * time.Millisecond):
	}
	cancel()
	pids := make(map[int]bool)
	for index := 0; index < 8; index++ {
		select {
		case value := <-results:
			var failure *room.SetupError
			if value.media != nil || !errors.As(value.err, &failure) || failure.Cleanup == nil {
				t.Fatal("blocked actual child lost cleanup owner", value.err)
			}
			owner, ok := failure.Cleanup.(*Proxy)
			if !ok {
				t.Fatal("blocked child lost PID")
			}
			if pids[owner.PID()] {
				t.Fatal("capacity owners did not identify eight distinct production children")
			}
			pids[owner.PID()] = true
			terminated(t, owner)
		case <-time.After(4 * time.Second):
			t.Fatal("cancelled capacity owner did not return promptly")
		}
	}
}

func TestProductionWorkerMalformedIPCAndWriterEOFActuallyTerminate(t *testing.T) {
	path, _, _, _ := environment(t)
	for _, mode := range []string{"oversized", "malformed", "eof"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, path, "--livekit-worker")
			// No media credential is placed in arguments, environment overrides, or diagnostics.
			cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "LD_LIBRARY_PATH=" + os.Getenv("LD_LIBRARY_PATH"), "DYLD_LIBRARY_PATH=" + os.Getenv("DYLD_LIBRARY_PATH")}
			cmd.Stderr = io.Discard
			var output bytes.Buffer
			cmd.Stdout = &output
			input, err := cmd.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err := cmd.Start(); err != nil {
				t.Fatal("actual production worker failed to start")
			}
			t.Cleanup(func() {
				if cmd.ProcessState == nil {
					_ = cmd.Process.Kill()
					_ = cmd.Wait()
				}
			})
			pid := cmd.Process.Pid
			switch mode {
			case "oversized":
				var header [4]byte
				binary.BigEndian.PutUint32(header[:], Max+1)
				if _, err := input.Write(header[:]); err != nil {
					t.Fatal("could not deliver malformed production IPC")
				}
			case "malformed":
				body := []byte(`{"version":1,"session":"client-rvs_invalid","id":1,"op":"join","unknown":true}`)
				var header [4]byte
				binary.BigEndian.PutUint32(header[:], uint32(len(body)))
				if _, err := input.Write(append(header[:], body...)); err != nil {
					t.Fatal("could not deliver unknown-key IPC")
				}
			}
			_ = input.Close()
			// A refusal exit may be nonzero; successful resource receipt is actual Wait, never an action ACK.
			_ = cmd.Wait()
			if ctx.Err() != nil || cmd.ProcessState == nil {
				t.Fatal("malformed IPC or writer EOF failed to terminate real worker")
			}
			if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
				t.Fatalf("malformed worker remained alive after Wait: %v", err)
			}
			if output.Len() != 0 {
				t.Fatal("invalid first IPC invented a native action acknowledgement")
			}
		})
	}
}
