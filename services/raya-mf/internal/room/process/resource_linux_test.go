//go:build cgo && linux

package process

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
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

// Diagnostic startup inspection preserves actual frames and stops inspecting
// after a fixed 16 messages. No private startup fields or payloads are retained.
type startup struct {
	input   io.Reader
	buffer  bytes.Buffer
	mu      sync.Mutex
	count   int
	last    string
	rate    int
	bytes   int
	failure string
	at      time.Time
}

func (s *startup) Read(body []byte) (int, error) {
	if s.buffer.Len() != 0 {
		return s.buffer.Read(body)
	}
	s.mu.Lock()
	count := s.count
	s.mu.Unlock()
	if count >= 16 {
		return s.input.Read(body)
	}
	message, err := Read(s.input)
	s.mu.Lock()
	s.count++
	s.at = time.Now()
	if err != nil {
		if s.failure == "" {
			s.failure = "framing"
			if errors.Is(err, io.EOF) {
				s.failure = "eof"
			}
		}
		s.mu.Unlock()
		return 0, err
	}
	s.last = message.Op
	if message.Frame != nil {
		s.rate = message.Frame.Rate
		s.bytes = len(message.Frame.PCM)
	}
	if message.Error != "" {
		s.failure = message.Error
	}
	s.mu.Unlock()
	if err := Write(&s.buffer, message); err != nil {
		return 0, err
	}
	return s.buffer.Read(body)
}

func (s *startup) snapshot() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return fmt.Sprintf("frames=%d last=%s failure=%s rate=%d pcmBytes=%d at=%s", s.count, s.last, s.failure, s.rate, s.bytes, s.at.UTC().Format(time.RFC3339Nano))
}

type resource struct {
	PID     int    `json:"pid"`
	Start   uint64 `json:"startTicks"`
	RSS     uint64 `json:"rssKiB"`
	PSS     uint64 `json:"pssKiB"`
	Threads uint64 `json:"threads"`
	FDs     int    `json:"fds"`
}

type window struct {
	Seconds  float64           `json:"seconds"`
	Phase    string            `json:"phase"`
	Slots    int               `json:"slots"`
	Parent   resource          `json:"parent"`
	Children []resource        `json:"children"`
	OwnedPSS uint64            `json:"ownedPssKiB"`
	Group    map[string]string `json:"cgroup"`
	Signals  uint64            `json:"nonzeroInputFrames"`
	Packets  uint64            `json:"receivedOpusPackets"`
	Controls uint64            `json:"receivedControl"`
	Runtime  *heap             `json:"parentGoRuntime,omitempty"`
}

// Numeric runtime counters describe this Go test parent, including its SDK
// observer and retained measurement/report buffers, not the production child.
type heap struct {
	Alloc      uint64 `json:"heapAllocBytes"`
	Inuse      uint64 `json:"heapInuseBytes"`
	Sys        uint64 `json:"heapSysBytes"`
	GC         uint32 `json:"numGC"`
	Goroutines int    `json:"goroutines"`
}

type spread struct {
	Count int     `json:"count"`
	Min   float64 `json:"min"`
	P50   float64 `json:"p50"`
	P95   float64 `json:"p95"`
	Max   float64 `json:"max"`
}

type retirement struct {
	PID     int     `json:"pid"`
	Start   uint64  `json:"startTicks"`
	Seconds float64 `json:"seconds"`
	Wait    bool    `json:"actualWait"`
	Absent  bool    `json:"pidAbsent"`
	Ready   float64 `json:"readySeconds"`
	Active  float64 `json:"activeSeconds"`
}

// Terminal failure evidence describes only owners actually joined. SDK
// Disconnect returning is not a claim that its inaccessible private loops joined.
type resourceCleanup struct {
	PID      int               `json:"pid"`
	Start    uint64            `json:"startTicks"`
	Done     bool              `json:"childDone"`
	Wait     bool              `json:"actualWait"`
	Absent   bool              `json:"pidAbsent"`
	Exit     exit              `json:"exit"`
	Input    bool              `json:"inputDrainJoined"`
	Observer bool              `json:"observerReadersJoined"`
	Slots    int               `json:"ownedSlotsAfterCleanup"`
	Group    map[string]string `json:"finalCgroup"`
}

func summarize(values []float64) spread {
	if len(values) == 0 {
		return spread{}
	}
	values = append([]float64(nil), values...)
	sort.Float64s(values)
	return spread{Count: len(values), Min: values[0], P50: values[(len(values)-1)/2], P95: values[(len(values)*95+99)/100-1], Max: values[len(values)-1]}
}

func identity(pid int) (uint64, error) {
	body, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, err
	}
	end := strings.LastIndexByte(string(body), ')')
	if end < 0 {
		return 0, errors.New("invalid proc stat")
	}
	fields := strings.Fields(string(body[end+1:]))
	if len(fields) < 20 {
		return 0, errors.New("missing proc starttime")
	}
	return strconv.ParseUint(fields[19], 10, 64)
}

func observe(pid int, expected uint64) (resource, error) {
	start, err := identity(pid)
	if err != nil || start != expected {
		return resource{}, errors.New("owned process identity disappeared or changed")
	}
	value := resource{PID: pid, Start: start}
	rollup, err := os.ReadFile(fmt.Sprintf("/proc/%d/smaps_rollup", pid))
	if err != nil {
		return value, err
	}
	seen := map[string]bool{}
	for _, line := range strings.Split(string(rollup), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 3 || (fields[0] != "Rss:" && fields[0] != "Pss:") {
			continue
		}
		count, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil || fields[2] != "kB" {
			return value, errors.New("invalid proc memory units")
		}
		seen[fields[0]] = true
		if fields[0] == "Rss:" {
			value.RSS = count
		}
		if fields[0] == "Pss:" {
			value.PSS = count
		}
	}
	if !seen["Rss:"] || !seen["Pss:"] {
		return value, errors.New("missing proc memory observation")
	}
	body, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return value, err
	}
	for _, line := range strings.Split(string(body), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 || fields[0] != "Threads:" {
			continue
		}
		value.Threads, err = strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			return value, err
		}
	}
	if value.Threads == 0 {
		return value, errors.New("missing proc thread count")
	}
	fds, err := os.ReadDir(fmt.Sprintf("/proc/%d/fd", pid))
	if err != nil {
		return value, err
	}
	value.FDs = len(fds)
	after, err := identity(pid)
	if err != nil || after != start {
		return value, errors.New("proc identity changed during observation")
	}
	return value, nil
}

// stat evidence deliberately excludes executable names, arguments and payloads.
type proc struct {
	Present bool   `json:"present"`
	State   string `json:"state"`
	Start   uint64 `json:"startTicks"`
	Error   string `json:"error,omitempty"`
}

func position(pid int) proc {
	body, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if errors.Is(err, os.ErrNotExist) {
		return proc{Error: "absent"}
	}
	if err != nil {
		return proc{Error: "unavailable"}
	}
	end := strings.LastIndexByte(string(body), ')')
	if end < 0 {
		return proc{Present: true, Error: "invalid"}
	}
	fields := strings.Fields(string(body[end+1:]))
	if len(fields) < 20 || len(fields[0]) != 1 || !strings.Contains("RSDZTtXxKWPI", fields[0]) {
		return proc{Present: true, Error: "invalid"}
	}
	start, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil {
		return proc{Present: true, Error: "invalid"}
	}
	return proc{Present: true, State: fields[0], Start: start}
}

// These are separate container/cgroup observations, never the owned-process sum.
func group() map[string]string {
	values := map[string]string{}
	for _, name := range []string{"memory.current", "memory.events", "memory.max", "memory.peak", "pids.current", "pids.max"} {
		body, err := os.ReadFile(filepath.Join("/sys/fs/cgroup", name))
		if err != nil {
			values[name] = "unavailable"
			continue
		}
		values[name] = strings.TrimSpace(string(body))
	}
	return values
}

// Explicit prolonged synthetic full-duplex codec/SFU/IPC observation. This does
// not measure provider calls, devices, acoustic playback or the separate SFU's
// resources, and reports measured drift without asserting an invented plateau.
func TestProductionWorkerSustainedResources(t *testing.T) {
	traced, err := diagnostic(os.Getenv("RAYA_TEST_PARENT_TRACE"))
	if err != nil {
		t.Fatal(err)
	}
	lost := os.Getenv("RAYA_TEST_RESOURCE_LOST_ACK")
	if lost != "" && lost != "1" {
		t.Fatal("resource lost-ACK fixture gate must be exactly 1")
	}
	mode, err := strategy(os.Getenv("RAYA_TEST_RESOURCE_MODE"))
	if err != nil {
		t.Fatal(err)
	}
	raw := os.Getenv("RAYA_TEST_RESOURCE_SECONDS")
	if raw == "" {
		t.Skip("requires explicit bounded resource observation duration")
	}
	seconds, err := strconv.Atoi(raw)
	if err != nil || seconds < 60 || seconds > 1800 {
		t.Fatal("resource duration must be an integer from 60 through 1800 seconds")
	}
	report := os.Getenv("RAYA_TEST_RESOURCE_REPORT")
	if report != "" && !filepath.IsAbs(report) {
		t.Fatal("optional resource report path must be absolute")
	}
	defer func() {
		t.Logf("resource_outcome {\"configuredSeconds\":%d,\"mode\":%q,\"failed\":%t}", seconds, mode, t.Failed())
	}()
	path, url, key, secret := environment(t)
	if len(slots) != 0 {
		t.Fatal("resource scope already contains another owned transport")
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal("production binary fingerprint unavailable", err)
	}
	hash := sha256.Sum256(body)
	body = nil
	parent, err := identity(os.Getpid())
	if err != nil {
		t.Fatal("parent identity unavailable", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(seconds+120)*time.Second)
	defer cancel()
	id := fmt.Sprintf("rvs_resource_%d", time.Now().UnixNano())
	name, client, owner := "raya-"+id, "client-"+id, "media-"+id
	token := func(identity string) string {
		value, err := auth.NewAccessToken(key, secret).SetIdentity(identity).SetValidFor(time.Hour).SetVideoGrant(&auth.VideoGrant{RoomJoin: true, Room: name}).ToJWT()
		if err != nil {
			t.Fatal("synthetic SFU token creation failed")
		}
		return value
	}
	var packets, controls, inputs, signals atomic.Uint64
	var expected atomic.Value
	expected.Store("")
	var delivered atomic.Bool
	fault := make(chan error, 1)
	var readers sync.WaitGroup
	var admission sync.Mutex
	closing := false
	peer := lksdk.NewRoom(&lksdk.RoomCallback{ParticipantCallback: lksdk.ParticipantCallback{
		OnTrackSubscribed: func(track *webrtc.TrackRemote, pub *lksdk.RemoteTrackPublication, participant *lksdk.RemoteParticipant) {
			if participant.Identity() != owner || pub.Source() != lkproto.TrackSource_MICROPHONE {
				return
			}
			admission.Lock()
			if closing || ctx.Err() != nil {
				admission.Unlock()
				return
			}
			readers.Add(1)
			admission.Unlock()
			go func() {
				defer readers.Done()
				stop := context.AfterFunc(ctx, func() { _ = track.SetReadDeadline(time.Now()) })
				defer stop()
				for {
					packet, _, err := track.ReadRTP()
					if err != nil {
						return
					}
					if packet.Padding && packet.PaddingSize > 0 && len(packet.Payload) == 0 {
						continue
					}
					if len(packet.Payload) == 0 || len(packet.Payload) > 1275 {
						select {
						case fault <- errors.New("invalid actual SFU Opus packet"):
						default:
						}
						return
					}
					packets.Add(1)
				}
			}()
		},
		OnTrackUnsubscribed: func(track *webrtc.TrackRemote, _ *lksdk.RemoteTrackPublication, _ *lksdk.RemoteParticipant) {
			_ = track.SetReadDeadline(time.Now())
		},
		OnDataPacket: func(packet lksdk.DataPacket, params lksdk.DataReceiveParams) {
			admission.Lock()
			defer admission.Unlock()
			if closing || ctx.Err() != nil {
				return
			}
			value, ok := packet.(*lksdk.UserDataPacket)
			if ok && params.SenderIdentity == owner && value.Topic == "raya.resource" {
				if string(value.Payload) != expected.Load().(string) || delivered.Swap(true) {
					select {
					case fault <- errors.New("actual control nonce changed or duplicated"):
					default:
					}
					return
				}
				controls.Add(1)
			}
		},
	}})
	var proxy *Proxy
	var action *observation
	var terminal func()
	var inputend <-chan struct{}
	var current struct {
		pid   int
		start uint64
		ready time.Time
	}
	cleanup := resourceCleanup{}
	// Registered first, so even a fatal cleanup assertion cannot prevent the
	// terminal report from observing both independently bounded cleanup owners.
	t.Cleanup(func() {
		if terminal != nil {
			terminal()
		}
	})
	// Independent cleanups ensure even a fatal child-reaping assertion cannot
	// bypass the observer's callback fence and owned reader join.
	t.Cleanup(func() {
		admission.Lock()
		closing = true
		admission.Unlock()
		cancel()
		end := make(chan struct{})
		go func() { peer.Disconnect(); readers.Wait(); close(end) }()
		select {
		case <-end:
			cleanup.Observer = true
		case <-time.After(4 * time.Second):
			t.Error("resource observer owners did not finish")
		}
	})
	t.Cleanup(func() {
		cancel()
		if proxy != nil {
			cleanup.PID, cleanup.Start = current.pid, current.start
			_ = proxy.Close()
			select {
			case <-proxy.Done():
				cleanup.Done = true
				cleanup.Exit = proxy.outcome()
				cleanup.Wait = cleanup.Exit.Known
				cleanup.Absent = current.pid > 0 && errors.Is(syscall.Kill(current.pid, 0), syscall.ESRCH)
				if !cleanup.Wait || !cleanup.Absent || proxy.Err() != nil {
					t.Error("failed resource child cleanup lacks exact Wait/PID-absence receipt")
				}
			case <-time.After(4 * time.Second):
				t.Error("failed resource child cleanup remains unknown")
			}
		}
		if inputend != nil {
			select {
			case <-inputend:
				cleanup.Input = true
			case <-time.After(time.Second):
				t.Error("resource input drain remained owned after cleanup")
			}
		}
	})
	if err := peer.JoinWithContextAndToken(ctx, url, token(client)); err != nil {
		t.Fatal("actual SFU client join failed", err)
	}
	track, err := lksdk.NewLocalTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := peer.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: "resource-synthetic", Source: lkproto.TrackSource_MICROPHONE, DisableDTX: true}); err != nil {
		t.Fatal(err)
	}
	for !track.IsBound() {
		select {
		case <-ctx.Done():
			t.Fatal("synthetic track binding failed")
		case <-time.After(10 * time.Millisecond):
		}
	}
	sample := make(media.PCM16Sample, 480)
	pcm := make([]byte, 960)
	for index := range sample {
		sample[index] = int16(2000 * math.Sin(2*math.Pi*440*float64(index)/24000))
		binary.LittleEndian.PutUint16(pcm[index*2:], uint16(sample[index]))
	}
	encoded := &encoded{}
	codec, err := opus.Encode(encoded, 1, logger.GetLogger())
	if err != nil {
		t.Fatal(err)
	}
	if err := codec.WriteSample(sample); err != nil {
		t.Fatal(err)
	}
	if err := codec.Close(); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	t.Logf("resource_start {\"configuredSeconds\":%d,\"mode\":%q,\"binarySha256\":%q,\"parentPid\":%d,\"parentStartTicks\":%d}", seconds, mode, hex.EncodeToString(hash[:]), os.Getpid(), parent)
	end := started.Add(time.Duration(seconds) * time.Second)
	windows := make([]window, 0, seconds+120)
	reaped := make([]retirement, 0, seconds/30+1)
	var cycles, published uint64
	active := 0.0
	unknown := false
	captured := make(chan Message, 1)
	failure := struct {
		elapsed float64
		slots   int
	}{}
	defer func() {
		if t.Failed() {
			failure.elapsed = time.Since(started).Seconds()
			failure.slots = len(slots)
		}
	}()
	terminal = func() {
		if !t.Failed() {
			return
		}
		cleanup.Slots, cleanup.Group = len(slots), group()
		if failure.elapsed == 0 {
			failure.elapsed = time.Since(started).Seconds()
		}
		observed := 0.0
		if !current.ready.IsZero() {
			for _, entry := range windows {
				if entry.Phase == "active" && len(entry.Children) == 1 && entry.Children[0].PID == current.pid && entry.Children[0].Start == current.start {
					observed = max(observed, entry.Seconds-current.ready.Sub(started).Seconds())
				}
			}
		}
		partial := struct {
			Configured int             `json:"configuredSeconds"`
			Elapsed    float64         `json:"elapsedSeconds"`
			Binary     string          `json:"binarySha256"`
			Outcome    string          `json:"outcome"`
			Slots      int             `json:"ownedSlotsBeforeCleanup"`
			Windows    []window        `json:"rawWindows"`
			Completed  bool            `json:"completed"`
			Reaped     []retirement    `json:"retirements"`
			Mode       string          `json:"mode"`
			Active     float64         `json:"completedActiveSeconds"`
			Observed   float64         `json:"observedActiveSeconds"`
			Cleanup    resourceCleanup `json:"cleanup"`
			Unknown    bool            `json:"unknownPublish"`
			Action     *observation    `json:"parentAction,omitempty"`
			Lost       struct {
				Captured bool   `json:"captured"`
				ID       uint64 `json:"id"`
				Outcome  string `json:"outcome"`
			} `json:"lostAck"`
		}{Configured: seconds, Elapsed: failure.elapsed, Binary: hex.EncodeToString(hash[:]), Outcome: "failed-partial-after-bounded-cleanup", Slots: failure.slots, Windows: windows, Completed: false, Reaped: reaped, Mode: mode, Active: active, Observed: observed, Cleanup: cleanup, Unknown: unknown}
		if proxy != nil && proxy.trace != nil {
			value := proxy.trace.snapshot()
			partial.Action = &value
		} else if action != nil {
			partial.Action = action
		}
		select {
		case ack := <-captured:
			partial.Lost.Captured = true
			partial.Lost.ID = ack.ID
			partial.Lost.Outcome = ack.Outcome
		default:
		}
		data, err := json.Marshal(partial)
		if err != nil {
			t.Error("partial resource report serialization failed", err)
			return
		}
		t.Logf("resource_partial %s", data)
		if report != "" {
			if err := os.WriteFile(report, append(data, '\n'), 0644); err != nil {
				t.Error("partial resource report write failed", err)
			}
		}
	}
	cadence := make([]float64, 0, seconds*50)
	var previous time.Time
	var inspected *startup
	record := func(phase string, pid int, start uint64) {
		value, err := observe(os.Getpid(), parent)
		if err != nil {
			t.Fatal("parent resource observation failed", err)
		}
		entry := window{Seconds: time.Since(started).Seconds(), Phase: phase, Slots: len(slots), Parent: value, OwnedPSS: value.PSS, Group: group(), Signals: signals.Load(), Packets: packets.Load(), Controls: controls.Load()}
		var stats runtime.MemStats
		runtime.ReadMemStats(&stats)
		entry.Runtime = &heap{Alloc: stats.HeapAlloc, Inuse: stats.HeapInuse, Sys: stats.HeapSys, GC: stats.NumGC, Goroutines: runtime.NumGoroutine()}
		if pid != 0 {
			child, err := observe(pid, start)
			if err != nil {
				before := position(pid)
				stopped := proxy.stopped.Load()
				initial := inspected.snapshot()
				done := false
				timer := time.NewTimer(4 * time.Second)
				select {
				case <-proxy.Done():
					done = true
				case <-timer.C:
				}
				timer.Stop()
				data, encoding := json.Marshal(struct {
					PID      int               `json:"pid"`
					Expected uint64            `json:"expectedStartTicks"`
					Stopped  bool              `json:"stoppedAtFailure"`
					Done     bool              `json:"doneAfterDiagnosticWait"`
					Exit     exit              `json:"exit"`
					Before   proc              `json:"beforeWait"`
					After    proc              `json:"afterWait"`
					Group    map[string]string `json:"cgroup"`
				}{pid, start, stopped, done, proxy.outcome(), before, position(pid), group()})
				if encoding != nil {
					t.Fatal("resource failure diagnostic serialization failed", encoding)
				}
				t.Logf("resource_failure_diagnostic %s", data)
				t.Fatalf("child resource observation failed: %v; stoppedInitially=%t done=%t inputQueued=%d slots=%d startupInitially=%s startupAfterWait=%s", err, stopped, done, len(proxy.input), len(slots), initial, inspected.snapshot())
			}
			entry.Children = []resource{child}
			entry.OwnedPSS += child.PSS
		}
		if entry.Slots != len(entry.Children) {
			t.Fatal("slot count disagrees with all owned active/retiring children")
		}
		windows = append(windows, entry)
		data, err := json.Marshal(entry)
		if err != nil {
			t.Fatal("raw resource sample serialization failed", err)
		}
		t.Logf("resource_sample %s", data)
	}
	for time.Now().Before(end) {
		current.pid, current.start, current.ready = 0, 0, time.Time{}
		inputend = nil
		joined, err := (Factory{Path: path, trace: traced, wrap: func(input io.Reader) io.Reader {
			if lost == "1" {
				input = &loss{input: input, session: client, captured: captured, observed: make(chan struct{})}
			}
			inspected = &startup{input: input}
			return inspected
		}}).JoinAudioAuthorized(ctx, url, token(owner), name, client, 24000)
		if err != nil {
			var setup *room.SetupError
			if errors.As(err, &setup) && setup.Cleanup != nil {
				if value, ok := setup.Cleanup.(*Proxy); ok {
					proxy = value
					current.pid = value.PID()
					current.start, _ = identity(current.pid)
				}
			}
			t.Fatal("actual production child join failed", err)
		}
		proxy = joined.(*Proxy)
		ready := time.Now()
		t.Logf("resource_child_ready pid=%d at=%s startup=%s", proxy.PID(), time.Now().UTC().Format(time.RFC3339Nano), inspected.snapshot())
		pid := proxy.PID()
		current.pid, current.ready = pid, ready
		start, err := identity(pid)
		if err != nil {
			t.Fatal("owned child starttime unavailable", err)
		}
		current.start = start
		cycles++
		before := signals.Load()
		outbound := packets.Load()
		drained := make(chan struct{})
		inputend = drained
		go func(p *Proxy) {
			defer close(drained)
			for {
				var frame engine.Frame
				select {
				case <-ctx.Done():
					return
				case <-p.Done():
					return
				case frame = <-p.Input():
				}
				if frame.Rate != 24000 || len(frame.PCM) != 960 {
					select {
					case fault <- errors.New("actual decoded input changed mono 20ms shape"):
					default:
					}
					return
				}
				inputs.Add(1)
				for index := 0; index < len(frame.PCM); index += 2 {
					if binary.LittleEndian.Uint16(frame.PCM[index:]) != 0 {
						signals.Add(1)
						break
					}
				}
			}
		}(proxy)
		record("active", pid, start)
		until := time.Now().Add(30 * time.Second)
		if until.After(end) {
			until = end
		}
		// A final replacement still needs an observable audio window. Any small
		// overrun is included in elapsedSeconds, never hidden in configured time.
		minimum := time.Now().Add(10 * time.Second)
		if until.Before(minimum) {
			until = minimum
		}
		if mode == "continuous" {
			until = ready.Add(time.Duration(seconds) * time.Second)
		}
		next := time.Now().Add(time.Second)
		bootstrap := time.Now().Add(5 * time.Second)
		incoming, outgoing := signals.Load(), packets.Load()
		tick := time.NewTicker(engine.FramePeriod)
		for time.Now().Before(until) {
			select {
			case <-ctx.Done():
				tick.Stop()
				t.Fatal("resource observation deadline exceeded")
			case err := <-fault:
				tick.Stop()
				t.Fatal(err)
			case <-proxy.Failure():
				tick.Stop()
				t.Fatal("production child failed during resource observation")
			case <-tick.C:
			}
			at := time.Now()
			if !previous.IsZero() {
				cadence = append(cadence, at.Sub(previous).Seconds()*1000)
			}
			previous = at
			published++
			if err := track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: uint16(published), Timestamp: uint32(published * 960)}, Payload: encoded.packet}, nil); err != nil {
				tick.Stop()
				t.Fatal("actual synthetic microphone send failed", err)
			}
			if err := proxy.Publish(ctx, engine.Frame{Rate: 24000, PCM: pcm, Epoch: 1, Seq: published, Start: (published - 1) * 480, End: published * 480, Item: "resource-output", At: at}); err != nil {
				unknown = errors.Is(err, ErrUnknown)
				tick.Stop()
				t.Fatal("production PCM publish failed", err)
			}
			if at.After(next) {
				count := controls.Load()
				body := fmt.Sprintf(`{"type":"resource-probe","sequence":%d}`, published)
				expected.Store(body)
				delivered.Store(false)
				if err := proxy.Send(ctx, room.Data{Topic: "raya.resource", Body: []byte(body)}); err != nil {
					tick.Stop()
					t.Fatal("production control send failed", err)
				}
				deadline := time.Now().Add(time.Second)
				for controls.Load() == count && time.Now().Before(deadline) {
					time.Sleep(time.Millisecond)
				}
				if controls.Load() == count {
					tick.Stop()
					t.Fatal("actual client control delivery missing")
				}
				if at.After(bootstrap) && (signals.Load() == incoming || packets.Load() == outgoing) {
					tick.Stop()
					t.Fatal("measured full-duplex audio window stalled after 5-second subscription allowance")
				}
				incoming, outgoing = signals.Load(), packets.Load()
				record("active", pid, start)
				next = at.Add(time.Second)
			}
		}
		tick.Stop()
		if signals.Load() == before || packets.Load() == outbound {
			t.Fatal("cycle lacked actual nonzero decoded microphone input or received output RTP")
		}
		record("retiring-admission", pid, start)
		duration := time.Since(ready).Seconds()
		_ = proxy.Close()
		select {
		case <-proxy.Done():
		case <-time.After(4 * time.Second):
			t.Fatal("retiring process did not reach actual Wait")
		}
		terminated(t, proxy)
		if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
			t.Fatal("child leaked after retirement", err)
		}
		active += duration
		reaped = append(reaped, retirement{PID: pid, Start: start, Seconds: time.Since(started).Seconds(), Wait: true, Absent: true, Ready: ready.Sub(started).Seconds(), Active: duration})
		select {
		case <-inputend:
		case <-time.After(time.Second):
			t.Fatal("parent input drain remained owned after child Wait")
		}
		if traced && mode == "continuous" && proxy.trace != nil {
			value := proxy.trace.snapshot()
			action = &value
		}
		proxy = nil
		record("retired", 0, 0)
		if mode == "continuous" {
			break
		}
	}
	if packets.Load() == 0 || controls.Load() == 0 || inputs.Load() == 0 || (mode == "churn" && cycles < 2) || (mode == "continuous" && cycles != 1) {
		t.Fatal("resource journey did not exercise the expected full-duplex transport and lifecycle mode")
	}
	select {
	case err := <-fault:
		t.Fatal("final resource observer failed", err)
	default:
	}
	values := map[string][]float64{}
	for _, entry := range windows {
		if entry.Phase != "active" {
			continue
		}
		values["ownedPssKiB"] = append(values["ownedPssKiB"], float64(entry.OwnedPSS))
		values["parentThreads"] = append(values["parentThreads"], float64(entry.Parent.Threads))
		values["parentFds"] = append(values["parentFds"], float64(entry.Parent.FDs))
		if len(entry.Children) == 1 {
			values["childPssKiB"] = append(values["childPssKiB"], float64(entry.Children[0].PSS))
			values["childThreads"] = append(values["childThreads"], float64(entry.Children[0].Threads))
			values["childFds"] = append(values["childFds"], float64(entry.Children[0].FDs))
		}
	}
	distributions := map[string]spread{}
	for key, value := range values {
		distributions[key] = summarize(value)
	}
	distributions["publishCadenceMs"] = summarize(cadence)
	var initial, last []float64
	for _, entry := range windows {
		if entry.Phase != "active" || entry.Seconds < 60 {
			continue
		}
		if entry.Seconds < 120 {
			initial = append(initial, float64(entry.OwnedPSS))
		}
		if entry.Seconds >= float64(seconds-60) {
			last = append(last, float64(entry.OwnedPSS))
		}
	}
	result := struct {
		Version       int               `json:"version"`
		Binary        string            `json:"binarySha256"`
		Go            string            `json:"go"`
		OS            string            `json:"os"`
		Arch          string            `json:"arch"`
		Configured    int               `json:"configuredSeconds"`
		Elapsed       float64           `json:"elapsedSeconds"`
		Warmup        int               `json:"warmupSeconds"`
		Scope         string            `json:"scope"`
		Cycles        uint64            `json:"cycles"`
		Published     uint64            `json:"published"`
		Input         uint64            `json:"decodedInputFrames"`
		Packets       uint64            `json:"receivedOpusPackets"`
		Control       uint64            `json:"receivedControl"`
		Distributions map[string]spread `json:"distributions"`
		Initial       spread            `json:"postWarmupFirst60s"`
		Last          spread            `json:"final60s"`
		Windows       []window          `json:"rawWindows"`
		Completed     bool              `json:"completed"`
		Reaped        []retirement      `json:"retirements"`
		Mode          string            `json:"mode"`
		Active        float64           `json:"activeSeconds"`
		Action        *observation      `json:"parentAction,omitempty"`
	}{1, hex.EncodeToString(hash[:]), runtime.Version(), runtime.GOOS, runtime.GOARCH, seconds, time.Since(started).Seconds(), 60, "owned PSS=Go test parent (including synthetic SDK client)+all active/retiring production children; separate cgroup includes other container processes; SFU excluded from owned sum; no provider/device/acoustic measurement or plateau assertion", cycles, published, inputs.Load(), packets.Load(), controls.Load(), distributions, summarize(initial), summarize(last), windows, true, reaped, mode, active, action}
	data, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if report != "" {
		if err := os.WriteFile(report, append(data, '\n'), 0644); err != nil {
			t.Fatal("resource report write failed", err)
		}
	}
	compact, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("resource_measurement %s", compact)
	t.Logf("resource observation: configured=%ds elapsed=%.2fs cycles=%d samples=%d binary=%s", seconds, result.Elapsed, cycles, len(windows), result.Binary)
}
