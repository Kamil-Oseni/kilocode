// raya_change - Actual receiver ownership, reorder and refusal tests.
package livekit

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/transport/v4/packetio"
)

func receive(t *testing.T, decode func([]byte) error) (*receiver, chan<- *rtp.Packet) {
	t.Helper()
	packets := make(chan *rtp.Packet, 64)
	done := make(chan struct{})
	var once sync.Once
	r, err := newReceiver(func() (*rtp.Packet, error) {
		select {
		case packet := <-packets:
			return packet, nil
		case <-done:
			return nil, io.EOF
		}
	}, func() error { once.Do(func() { close(done) }); return nil }, decode, func() error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := r.Close(context.Background()); errors.Is(err, receiverUnknown) {
			t.Error(err)
		}
	})
	return r, packets
}
func frame(seq uint16) *rtp.Packet {
	return &rtp.Packet{Header: rtp.Header{SequenceNumber: seq}, Payload: []byte{byte(seq)}}
}
func awaited(t *testing.T, values <-chan byte) byte {
	t.Helper()
	select {
	case value := <-values:
		return value
	case <-time.After(time.Second):
		t.Fatal("decoder did not receive bounded packet")
		return 0
	}
}

func TestReceiverReordersDuplicatesWrapAndSkipsBoundedLoss(t *testing.T) {
	values := make(chan byte, 20)
	r, packets := receive(t, func(data []byte) error { values <- data[0]; return nil })
	packets <- frame(65534)
	if awaited(t, values) != 254 {
		t.Fatal("first packet changed")
	}
	packets <- frame(0)
	packets <- frame(65535)
	packets <- frame(65535)
	packets <- frame(1)
	for _, expected := range []byte{255, 0, 1} {
		if awaited(t, values) != expected {
			t.Fatal("sequence wrap/reorder changed")
		}
	}
	begin := time.Now()
	packets <- frame(3)
	if awaited(t, values) != 3 || time.Since(begin) < 45*time.Millisecond {
		t.Fatal("loss gap was not bounded before skip")
	}
	select {
	case <-values:
		t.Fatal("duplicate was decoded")
	default:
	}
	if err := r.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestReceiverBlockedReadRetainsUnknownUntilActualReturn(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	var interrupts, finishes atomic.Int32
	r, err := newReceiver(func() (*rtp.Packet, error) { close(entered); <-release; return nil, io.EOF }, func() error { interrupts.Add(1); return errors.New("deadline unavailable") }, func([]byte) error { t.Error("stopped packet decoded"); return nil }, func() error { finishes.Add(1); return nil })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { once.Do(func() { close(release) }); _ = r.Close(context.Background()) })
	admitted(t, entered)
	if !errors.Is(r.Close(context.Background()), receiverUnknown) {
		t.Fatal("ignored read deadline fabricated terminal")
	}
	r.stop()
	r.stop()
	if interrupts.Load() != 1 || finishes.Load() != 0 {
		t.Fatal("blocked reader was replaced or decoder closed early")
	}
	once.Do(func() { close(release) })
	if err := r.Close(context.Background()); err == nil || errors.Is(err, receiverUnknown) {
		t.Fatal("actual terminal lost interruption error")
	}
	if finishes.Load() != 1 {
		t.Fatal("decoder finish was not joined once")
	}
}

func TestReceiverBlockedDecodeNeverClosesDecoderConcurrently(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	var finished atomic.Bool
	packets := make(chan *rtp.Packet, 1)
	packets <- frame(1)
	done := make(chan struct{})
	r, err := newReceiver(func() (*rtp.Packet, error) {
		select {
		case p := <-packets:
			return p, nil
		case <-done:
			return nil, io.EOF
		}
	}, func() error { close(done); return nil }, func([]byte) error {
		close(entered)
		<-release
		if finished.Load() {
			t.Error("decoder closed while decoding")
		}
		return nil
	}, func() error { finished.Store(true); return nil })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { once.Do(func() { close(release) }); _ = r.Close(context.Background()) })
	admitted(t, entered)
	if !errors.Is(r.Close(context.Background()), receiverUnknown) || finished.Load() {
		t.Fatal("blocked decode fabricated termination")
	}
	once.Do(func() { close(release) })
	if err := r.Close(context.Background()); err != nil || !finished.Load() {
		t.Fatal("released decoder was not joined")
	}
}

func TestReceiverRefusesPayloadAndReorderOverflow(t *testing.T) {
	for _, size := range []int{0, payload + 1} {
		packets := make(chan *rtp.Packet, 1)
		packets <- &rtp.Packet{Payload: make([]byte, size)}
		done := make(chan struct{})
		var writes atomic.Int32
		r, err := newReceiver(func() (*rtp.Packet, error) {
			select {
			case p := <-packets:
				return p, nil
			case <-done:
				return nil, io.EOF
			}
		}, func() error { close(done); return nil }, func([]byte) error { writes.Add(1); return nil }, func() error { return nil })
		if err != nil {
			t.Fatal(err)
		}
		select {
		case <-r.end:
		case <-time.After(time.Second):
			t.Fatal("invalid payload owner did not terminate")
		}
		if r.Close(context.Background()) == nil || writes.Load() != 0 {
			t.Fatal("invalid payload decoded")
		}
	}
	values := make(chan byte, 1)
	r, packets := receive(t, func(data []byte) error { values <- data[0]; return nil })
	packets <- frame(1)
	awaited(t, values)
	for seq := uint16(3); seq <= 11; seq++ {
		packets <- frame(seq)
		time.Sleep(time.Millisecond)
	}
	select {
	case <-r.end:
	case <-time.After(time.Second):
		t.Fatal("overflow was not bounded")
	}
	if !errors.Is(r.Close(context.Background()), receiverOverflow) {
		t.Fatal("reorder overflow silently dropped packets")
	}
}

func TestReceiverDecoderFailureIsTerminalAndCallbacksRequired(t *testing.T) {
	failure := errors.New("decode failed")
	r, packets := receive(t, func([]byte) error { return failure })
	packets <- frame(1)
	select {
	case <-r.end:
	case <-time.After(time.Second):
		t.Fatal("decode error did not terminate")
	}
	if !errors.Is(r.Close(context.Background()), failure) {
		t.Fatal("decode error was hidden")
	}
	if _, err := newReceiver(nil, func() error { return nil }, func([]byte) error { return nil }, func() error { return nil }); err == nil {
		t.Fatal("missing callback admitted")
	}
}

func TestReceiverBlockedInterruptRetainsItsSingleCleanupOwner(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})
	var once sync.Once
	var calls atomic.Int32
	r, err := newReceiver(func() (*rtp.Packet, error) { <-done; return nil, io.EOF }, func() error {
		calls.Add(1)
		close(entered)
		<-release
		close(done)
		return nil
	}, func([]byte) error { return nil }, func() error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { once.Do(func() { close(release) }); _ = r.Close(context.Background()) })
	r.stop()
	admitted(t, entered)
	if !errors.Is(r.Close(context.Background()), receiverUnknown) {
		t.Fatal("blocked interrupt fabricated termination")
	}
	r.stop()
	if calls.Load() != 1 {
		t.Fatal("Stop launched replacement cleanup")
	}
	once.Do(func() { close(release) })
	if err := r.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestReceiverClonesPayloadAndRefusesFastFIFOOverflow(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	var value atomic.Int32
	r, packets := receive(t, func(data []byte) error {
		close(entered)
		<-release
		value.Store(int32(data[0]))
		return nil
	})
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	packet := frame(1)
	packets <- packet
	admitted(t, entered)
	packet.Payload[0] = 99
	for seq := uint16(2); seq <= 11; seq++ {
		packets <- frame(seq)
	}
	select {
	case <-r.done:
	case <-time.After(time.Second):
		t.Fatal("fast sender grew beyond FIFO allowance")
	}
	if !errors.Is(r.Close(context.Background()), receiverUnknown) {
		t.Fatal("blocked decoder was discarded on overflow")
	}
	once.Do(func() { close(release) })
	if !errors.Is(r.Close(context.Background()), receiverOverflow) || value.Load() != 1 {
		t.Fatal("owned payload changed or overflow disappeared")
	}
}

func TestReceiverExpectedShutdownReadErrorsDoNotReportFailure(t *testing.T) {
	buffer := packetio.NewBuffer()
	defer buffer.Close()
	if err := buffer.SetReadDeadline(time.Now()); err != nil {
		t.Fatal(err)
	}
	_, timeout := buffer.Read(make([]byte, 1))
	if !os.IsTimeout(timeout) {
		t.Fatal("actual Pion buffer did not return its deadline error")
	}
	for _, failure := range []error{io.EOF, net.ErrClosed, os.ErrDeadlineExceeded, io.ErrClosedPipe, timeout} {
		done := make(chan struct{})
		reports := make(chan error, 1)
		r, err := newReceiver(func() (*rtp.Packet, error) { <-done; return nil, failure }, func() error { close(done); return nil }, func([]byte) error { return nil }, func() error { return nil }, reports)
		if err != nil {
			t.Fatal(err)
		}
		if err := r.Close(context.Background()); err != nil {
			t.Fatal(err)
		}
		select {
		case <-reports:
			t.Fatal("expected shutdown emitted a failure")
		default:
		}
	}
}

func TestReceiverReportsFatalFailureExactlyOnceAfterFence(t *testing.T) {
	failure := errors.New("read failed")
	reports := make(chan error, 4)
	r, err := newReceiver(func() (*rtp.Packet, error) { return nil, failure }, func() error { return errors.New("interrupt failed") }, func([]byte) error { return nil }, func() error { return errors.New("finish failed") }, reports)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-r.end:
	case <-time.After(time.Second):
		t.Fatal("fatal read did not terminate")
	}
	if !r.stopped.Load() || !errors.Is(r.Close(context.Background()), failure) || len(reports) != 1 {
		t.Fatal("fatal receiver did not fence and report once")
	}
	for _, expected := range []error{os.ErrDeadlineExceeded} {
		r, err := newReceiver(func() (*rtp.Packet, error) { return nil, expected }, func() error { return nil }, func([]byte) error { return nil }, func() error { return nil }, make(chan error))
		if err != nil {
			t.Fatal(err)
		}
		select {
		case <-r.end:
		case <-time.After(time.Second):
			t.Fatal("unobserved active read error blocked reporting")
		}
		if !errors.Is(r.Close(context.Background()), expected) {
			t.Fatal("active read error was mistaken for shutdown")
		}
	}
}

func TestReceiverPublicationEOFJoinsWithoutInventingRoomFailure(t *testing.T) {
	reports := make(chan error, 1)
	r, err := newReceiver(func() (*rtp.Packet, error) { return nil, io.EOF }, func() error { return nil }, func([]byte) error { return nil }, func() error { return nil }, reports)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-r.end:
	case <-time.After(time.Second):
		t.Fatal("ended publication did not join its owner")
	}
	if err := r.Close(context.Background()); err != nil || len(reports) != 0 {
		t.Fatal("publication EOF fabricated a room disconnect", err)
	}
}
