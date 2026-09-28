//go:build cgo

// raya_change - Actual libopus frame sizing and bounded encoder sink.
package livekit

import (
	"testing"

	"github.com/livekit/media-sdk"
	"github.com/livekit/media-sdk/opus"
	"github.com/livekit/protocol/logger"
)

type decoded struct{ samples int }

func (*decoded) String() string  { return "codec-check" }
func (*decoded) SampleRate() int { return 24000 }
func (d *decoded) WriteSample(sample media.PCM16Sample) error {
	d.samples += len(sample)
	return nil
}
func (*decoded) Close() error { return nil }

func TestOwnedCodecEmitsExactlyOneTwentyMillisecondPacket(t *testing.T) {
	output := &encoded{}
	encoder, err := opus.Encode(output, 1, logger.GetLogger())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := encoder.Close(); err != nil {
			t.Error(err)
		}
	})
	input := &decoded{}
	decoder, err := opus.Decode(input, 1, logger.GetLogger())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := decoder.Close(); err != nil {
			t.Error(err)
		}
	})
	for range 3 {
		output.packet = nil
		if err := encoder.WriteSample(make(media.PCM16Sample, 480)); err != nil {
			t.Fatal(err)
		}
		if len(output.packet) == 0 || len(output.packet) > payload {
			t.Fatal("encoder did not emit one bounded Opus packet")
		}
		prior := input.samples
		if err := decoder.WriteSample(output.packet); err != nil {
			t.Fatal(err)
		}
		if input.samples-prior != 480 {
			t.Fatal("one source frame did not decode to exactly 20 ms")
		}
	}
}

func TestEncoderSinkOwnsBytesAndRefusesDuplicatePackets(t *testing.T) {
	output := &encoded{}
	for _, sample := range []opus.Sample{nil, make(opus.Sample, payload+1)} {
		if err := output.WriteSample(sample); err == nil {
			t.Fatal("invalid encoded packet was retained")
		}
	}
	sample := opus.Sample{0xf8, 0xff, 0xfe}
	if err := output.WriteSample(sample); err != nil {
		t.Fatal(err)
	}
	sample[0] = 0
	if output.packet[0] != 0xf8 {
		t.Fatal("encoder sink borrowed mutable codec memory")
	}
	if err := output.WriteSample(sample); err == nil {
		t.Fatal("encoder emitted multiple packets for one frame")
	}
	if err := output.Close(); err != nil || output.packet != nil {
		t.Fatal("encoder sink retained its packet on close")
	}
}
