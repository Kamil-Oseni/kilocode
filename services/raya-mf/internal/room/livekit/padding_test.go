package livekit

import (
	"context"
	"errors"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
)

func TestReceiverActualUDPPionPaddingPreservesSequenceWithoutDecode(t *testing.T) {
	input, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	output, err := net.DialUDP("udp4", nil, input.LocalAddr().(*net.UDPAddr))
	if err != nil {
		t.Fatal(err)
	}
	defer output.Close()
	values := make(chan byte, 4)
	r, err := newReceiver(func() (*rtp.Packet, error) {
		body := make([]byte, 2048)
		n, _, err := input.ReadFromUDP(body)
		if err != nil {
			return nil, err
		}
		packet := &rtp.Packet{}
		if err := packet.Unmarshal(body[:n]); err != nil {
			return nil, err
		}
		return packet, nil
	}, input.Close, func(body []byte) error { values <- body[0]; return nil }, func() error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := r.Close(context.Background()); err != nil {
			t.Error(err)
		}
	}()
	padding := &rtp.Packet{Header: rtp.Header{Version: 2, Padding: true, PaddingSize: 12, SequenceNumber: 65535}}
	body, err := padding.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	decoded := &rtp.Packet{}
	if err := decoded.Unmarshal(body); err != nil || len(decoded.Payload) != 0 || decoded.Header.PaddingSize != 12 {
		t.Fatal("pinned Pion did not accept legal padding-only RTP", err)
	}
	send := func(packet *rtp.Packet) {
		t.Helper()
		body, err := packet.Marshal()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := output.Write(body); err != nil {
			t.Fatal(err)
		}
	}
	send(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: 65534}, Payload: []byte{1}})
	if awaited(t, values) != 1 {
		t.Fatal("initial real UDP payload changed")
	}
	// Send the following payload first: the real reorder loop must hold it
	// until the padding sequence arrives, then consume padding without decode.
	send(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: 0}, Payload: []byte{2}})
	send(padding)
	select {
	case value := <-values:
		if value != 2 {
			t.Fatal("payload following padding changed across sequence wrap")
		}
	case <-time.After(40 * time.Millisecond):
		t.Fatal("padding sequence was treated as missing and imposed the 60 ms loss gap")
	}
	send(padding)
	send(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: 1}, Payload: []byte{3}})
	if awaited(t, values) != 3 {
		t.Fatal("duplicate padding interfered with following payload")
	}
	select {
	case <-values:
		t.Fatal("padding generated codec output")
	default:
	}
	if r.stopped.Load() {
		t.Fatal("legal padding stopped receiver")
	}
}

func TestReceiverPaddingExceptionStillRefusesInvalidPayloads(t *testing.T) {
	for name, packet := range map[string]*rtp.Packet{
		"nil":          nil,
		"empty":        {Header: rtp.Header{Version: 2}},
		"zero_padding": {Header: rtp.Header{Version: 2, Padding: true}},
		"oversized":    {Header: rtp.Header{Version: 2, Padding: true, PaddingSize: 1}, Payload: make([]byte, payload+1)},
	} {
		t.Run(name, func(t *testing.T) {
			var calls atomic.Int32
			r, err := newReceiver(func() (*rtp.Packet, error) { return packet, nil }, func() error { return nil }, func([]byte) error { calls.Add(1); return nil }, func() error { return nil })
			if err != nil {
				t.Fatal(err)
			}
			select {
			case <-r.end:
			case <-time.After(time.Second):
				t.Fatal("invalid packet did not terminate owned receiver")
			}
			err = r.Close(context.Background())
			if err == nil || errors.Is(err, receiverUnknown) || calls.Load() != 0 {
				t.Fatal("invalid packet became decoded or unknown", err)
			}
		})
	}
}
