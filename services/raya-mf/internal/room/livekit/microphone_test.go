//go:build cgo

// raya_change - Native libopus mono/stereo conversion without a resampler or SDK read owner.
package livekit

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"sync"
	"testing"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/livekit/media-sdk"
	"github.com/livekit/media-sdk/opus"
	"github.com/livekit/protocol/logger"
	"github.com/pion/rtp"
)

func microphonePacket(t *testing.T, channels, duration int) []byte {
	t.Helper()
	output := &encoded{}
	encoder, err := opus.Encode(output, channels, logger.GetLogger())
	if err != nil {
		t.Fatal(err)
	}
	defer encoder.Close()
	sample := make(media.PCM16Sample, 24*duration*channels)
	for index := range 24 * duration {
		for channel := range channels {
			sample[index*channels+channel] = int16(3000 * math.Sin(2*math.Pi*440*float64(index)/24000))
		}
	}
	if err := encoder.WriteSample(sample); err != nil {
		t.Fatal(err)
	}
	return append([]byte(nil), output.packet...)
}

func microphoneFixture(t *testing.T, rate int) (*receiver, chan *rtp.Packet, chan engine.Frame, *sink) {
	t.Helper()
	packets := make(chan *rtp.Packet, 2)
	frames := make(chan engine.Frame, 2)
	input := &sink{writer: &writer{rate: rate, input: frames}}
	stopped := make(chan struct{})
	var once sync.Once
	value, err := newMicrophone(func() (*rtp.Packet, error) {
		select {
		case packet := <-packets:
			return packet, nil
		case <-stopped:
			return nil, io.EOF
		}
	}, func() error { once.Do(func() { close(stopped) }); return nil }, input)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = input.Close()
		if err := value.Close(ctx); errors.Is(err, context.DeadlineExceeded) {
			t.Error("microphone owner did not terminate", err)
		}
	})
	return value, packets, frames, input
}

func TestNativeMicrophoneMonoStereoRates(t *testing.T) {
	for _, rate := range []int{16000, 24000} {
		for _, channels := range []int{1, 2} {
			t.Run(fmt.Sprintf("%d/%d", rate, channels), func(t *testing.T) {
				value, packets, frames, input := microphoneFixture(t, rate)
				packets <- &rtp.Packet{Payload: microphonePacket(t, channels, 20)}
				select {
				case frame := <-frames:
					if frame.Rate != rate || len(frame.PCM) != rate/50*2 {
						t.Fatal("native decoder changed mono20ms shape")
					}
					signal := false
					for index := 0; index < len(frame.PCM); index += 2 {
						if int16(binary.LittleEndian.Uint16(frame.PCM[index:])) != 0 {
							signal = true
							break
						}
					}
					if !signal {
						t.Fatal("native decoder emitted no real synthetic signal")
					}
				case <-time.After(time.Second):
					t.Fatal("native microphone emitted no frame")
				}
				_ = input.Close()
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				defer cancel()
				if err := value.Close(ctx); err != nil {
					t.Fatal(err)
				}
				if err := input.WriteSample(make(media.PCM16Sample, rate/50)); err == nil {
					t.Fatal("Stop left decoder sink open")
				}
				packets <- &rtp.Packet{Payload: microphonePacket(t, channels, 20)}
				select {
				case <-frames:
					t.Fatal("Stop allowed a late decode or flush")
				case <-time.After(30 * time.Millisecond):
				}
			})
		}
	}
}

func TestNativeMicrophoneRejectsMalformedOrNonTwentyMillisecondAudio(t *testing.T) {
	cases := map[string][]byte{
		"empty":     nil,
		"oversize":  make([]byte, 1276),
		"malformed": {0xff},
		"short":     microphonePacket(t, 1, 10),
		"long":      microphonePacket(t, 1, 40),
	}
	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			value, packets, frames, _ := microphoneFixture(t, 24000)
			packets <- &rtp.Packet{Payload: payload}
			select {
			case <-value.end:
			case <-time.After(time.Second):
				t.Fatal("bad packet retained decoder owner")
			}
			select {
			case <-frames:
				t.Fatal("bad packet projected PCM")
			default:
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if err := value.Close(ctx); err == nil || errors.Is(err, context.DeadlineExceeded) {
				t.Fatal("bad packet did not retain an explicit decode refusal", err)
			}
		})
	}
}

// This verifies every owned lifecycle joins; retained test fixture references
// are intentionally not a process-memory or allocator plateau measurement.
func TestNativeMicrophoneRepeatedRetirementJoinsEveryOwner(t *testing.T) {
	packet := microphonePacket(t, 1, 20)
	for cycle := range 50 {
		rate := 16000
		if cycle%2 != 0 {
			rate = 24000
		}
		value, packets, frames, input := microphoneFixture(t, rate)
		packets <- &rtp.Packet{Payload: packet}
		select {
		case frame := <-frames:
			if frame.Rate != rate || len(frame.PCM) != rate/50*2 {
				t.Fatalf("cycle %d changed native mono20ms framing", cycle)
			}
		case <-time.After(time.Second):
			t.Fatalf("cycle %d did not decode actual Opus", cycle)
		}
		if err := input.Close(); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		err := value.Close(ctx)
		cancel()
		if err != nil && !errors.Is(err, receiverUnknown) {
			t.Fatalf("cycle %d retirement failed: %v", cycle, err)
		}
		select {
		case <-value.end:
		case <-time.After(time.Second):
			t.Fatalf("cycle %d retained read/decode/finish owner", cycle)
		}
		ctx, cancel = context.WithTimeout(context.Background(), time.Second)
		err = value.Close(ctx)
		cancel()
		if err != nil {
			t.Fatalf("cycle %d final retirement receipt failed: %v", cycle, err)
		}
	}
}

func TestNativeMicrophoneInputOverflowRefusesWithoutInventingContinuity(t *testing.T) {
	value, packets, frames, _ := microphoneFixture(t, 24000)
	packet := microphonePacket(t, 1, 20)
	for sequence := range 3 {
		packets <- &rtp.Packet{Header: rtp.Header{SequenceNumber: uint16(sequence)}, Payload: packet}
	}
	select {
	case <-value.end:
	case <-time.After(time.Second):
		t.Fatal("input overflow did not terminate the microphone owner")
	}
	if len(frames) != 2 || value.Close(context.Background()) == nil {
		t.Fatal("overflow was reported as complete continuous audio")
	}
}
