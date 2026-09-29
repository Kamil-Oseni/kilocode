//go:build cgo

// raya_change - Actual local codec/SDK/Room cleanup with controlled blocked writers.
package livekit

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/room"
	"github.com/livekit/media-sdk/opus"
	"github.com/livekit/protocol/logger"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

func shutdown(t *testing.T, audio func(*rtp.Packet) error, data func(room.Data) error) *Room {
	t.Helper()
	track, err := newTrack()
	if err != nil {
		t.Fatal(err)
	}
	output := &encoded{}
	codec, err := opus.Encode(output, 1, logger.GetLogger())
	if err != nil {
		t.Fatal(err)
	}
	sender, err := newSender(audio)
	if err != nil {
		_ = codec.Close()
		t.Fatal(err)
	}
	control, err := newControl(data)
	if err != nil {
		sender.stop()
		_ = codec.Close()
		t.Fatal(err)
	}
	input := make(chan engine.Frame, 64)
	value := &Room{
		room: lksdk.NewRoom(nil), track: track, codec: codec, encoded: output,
		sender: sender, control: control, writer: &writer{input: input, rate: 24000},
		input: input, data: make(chan room.Data, 64),
		remote: make(map[string]*receiver), remoteMu: &sync.Mutex{},
		tracks: make(map[string]*webrtc.TrackRemote), sinks: make(map[string]*sink),
		stopped: &atomic.Bool{}, done: make(chan struct{}),
	}
	t.Cleanup(func() {
		_ = value.Close()
		select {
		case <-value.done:
		case <-time.After(time.Second):
			t.Error("actual Room cleanup owner remained live")
		}
	})
	return value
}

func fences(t *testing.T, value *Room) {
	t.Helper()
	if !value.stopped.Load() || !value.sender.stopped.Load() || !value.control.stopped.Load() || !value.writer.closed.Load() {
		t.Fatal("Close did not synchronously fence every local lane")
	}
	if err := value.Send(context.Background(), room.Data{Topic: "test", Body: []byte("late")}); err == nil {
		t.Fatal("closed Room admitted data")
	}
	if err := value.writer.WriteSample(make([]int16, 480)); err == nil {
		t.Fatal("closed Room admitted microphone PCM")
	}
}

func bounded(t *testing.T, value *Room) {
	t.Helper()
	result := make(chan error, 1)
	go func() { result <- value.Close() }()
	select {
	case err := <-result:
		if !errors.Is(err, errUnknown) {
			t.Fatal("blocked cleanup was reported as complete", err)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("Room.Close blocked behind retained cleanup")
	}
	fences(t, value)
	select {
	case <-value.done:
		t.Fatal("Room.done closed before retained owner returned")
	default:
	}
}

func TestRoomCloseBoundedBehindDecoderAdmission(t *testing.T) {
	value := shutdown(t, func(*rtp.Packet) error { return nil }, func(room.Data) error { return nil })
	value.remoteMu.Lock()
	var once sync.Once
	release := func() { once.Do(value.remoteMu.Unlock) }
	defer release()
	bounded(t, value)
	release()
	select {
	case <-value.done:
	case <-time.After(time.Second):
		t.Fatal("Room cleanup did not finish after decoder lock release")
	}
}

func TestRoomCloseRetainsAdmittedWriters(t *testing.T) {
	for _, kind := range []string{"audio", "data"} {
		t.Run(kind, func(t *testing.T) {
			entered, blocked := make(chan struct{}), make(chan struct{})
			var once sync.Once
			release := func() { once.Do(func() { close(blocked) }) }
			defer release()
			audio := func(*rtp.Packet) error {
				if kind == "audio" {
					close(entered)
					<-blocked
				}
				return nil
			}
			data := func(room.Data) error {
				if kind == "data" {
					close(entered)
					<-blocked
				}
				return nil
			}
			value := shutdown(t, audio, data)
			sent := make(chan error, 1)
			go func() {
				if kind == "audio" {
					sent <- value.sender.Send(context.Background(), []byte{1})
					return
				}
				sent <- value.Send(context.Background(), room.Data{Topic: "test", Body: []byte("owned")})
			}()
			select {
			case <-entered:
			case <-time.After(time.Second):
				t.Fatal("actual owned writer did not admit command")
			}
			bounded(t, value)
			select {
			case <-value.done:
				t.Fatal("cleanup lost the blocked writer owner")
			case <-time.After(60 * time.Millisecond):
			}
			release()
			select {
			case err := <-sent:
				if kind == "audio" && !errors.Is(err, errUnknown) || kind == "data" && !errors.Is(err, controlUnknown) {
					t.Fatal("accepted blocked send lost its unknown outcome", err)
				}
			case <-time.After(time.Second):
				t.Fatal("admitted caller did not finish")
			}
			select {
			case <-value.done:
			case <-time.After(time.Second):
				t.Fatal("Room cleanup did not observe actual writer return")
			}
			if err := value.Close(); err != nil {
				t.Fatal("actual joined owners did not reconcile local cleanup", err)
			}
		})
	}
}
