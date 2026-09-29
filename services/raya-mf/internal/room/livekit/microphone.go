//go:build cgo

// raya_change - Native target-rate libopus decode under the joined receiver owner.
package livekit

import (
	"errors"

	"github.com/livekit/media-sdk"
	"github.com/livekit/media-sdk/opus"
	"github.com/livekit/protocol/logger"
	"github.com/pion/rtp"
)

// Stop callers fence input first. The receiver joins its read/decode workers
// before closing the codec; no SDK jitter or resampler goroutine is installed.
func newMicrophone(read func() (*rtp.Packet, error), interrupt func() error, input *sink, reports ...chan<- error) (*receiver, error) {
	if read == nil || interrupt == nil || input == nil || input.writer == nil {
		return nil, errors.New("microphone callbacks and sink are required")
	}
	if input.SampleRate() != 16000 && input.SampleRate() != 24000 {
		return nil, errors.New("microphone decoder requires native 16 kHz or 24 kHz output")
	}
	output := &observed{input: input}
	decoder, err := opus.Decode(output, 1, logger.GetLogger())
	if err != nil {
		return nil, err
	}
	value, err := newReceiver(read, interrupt, func(payload []byte) error {
		if len(payload) == 0 || len(payload) > 1275 {
			return errors.New("invalid bounded microphone Opus packet")
		}
		output.writes = 0
		if err := decoder.WriteSample(opus.Sample(payload)); err != nil {
			return err
		}
		// The pinned decoder tolerates some corrupt packets without emitting PCM.
		// Such a packet is a refusal, not silence or a successful audio frame.
		if output.writes != 1 {
			return errors.New("microphone packet did not emit exactly one 20 ms frame")
		}
		return nil
	}, decoder.Close, reports...)
	if err != nil {
		return nil, errors.Join(err, decoder.Close())
	}
	return value, nil
}

// Only the owned decode worker accesses writes. Exact native-rate mono PCM
// goes directly to the sink without timing synthesis or sample-rate conversion.
type observed struct {
	input  *sink
	writes int
}

func (o *observed) String() string  { return "raya-native-microphone" }
func (o *observed) SampleRate() int { return o.input.SampleRate() }
func (o *observed) Close() error    { return o.input.Close() }
func (o *observed) WriteSample(frame media.PCM16Sample) error {
	if o.writes != 0 || len(frame) != o.SampleRate()/50 {
		return errors.New("microphone decode changed mono 20 ms frame shape")
	}
	if err := o.input.WriteSample(frame); err != nil {
		return err
	}
	o.writes++
	return nil
}
