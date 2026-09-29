//go:build cgo && !windows

// Actual SFU effect plus generated child ACK lost before parent acceptance.
package process

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/room"
	"github.com/livekit/protocol/auth"
	lksdk "github.com/livekit/server-sdk-go/v2"
)

// The wrapper consumes real child frames. It neither fabricates a native effect
// nor changes ACK outcomes; exactly one real ACK never reaches Proxy.read.
type loss struct {
	input    io.Reader
	buffer   bytes.Buffer
	session  string
	captured chan<- Message
	observed <-chan struct{}
	stopped  bool
}

func (l *loss) Read(body []byte) (int, error) {
	if l.buffer.Len() != 0 {
		return l.buffer.Read(body)
	}
	if l.stopped {
		return 0, io.EOF
	}
	message, err := Read(l.input)
	if err != nil {
		return 0, err
	}
	if message.Op == "ack" && message.ID == 2 && message.Session == l.session {
		l.captured <- message
		l.stopped = true
		// Never extend the production action deadline to manufacture successful
		// receipt timing. External delivery and generated ACK are separate facts.
		timer := time.NewTimer(engine.FramePeriod)
		defer timer.Stop()
		select {
		case <-l.observed:
		case <-timer.C:
		}
		return 0, io.EOF
	}
	if err := Write(&l.buffer, message); err != nil {
		return 0, err
	}
	return l.buffer.Read(body)
}

func TestProductionWorkerActualSFUEffectWithLostACKNeverReplays(t *testing.T) {
	path, raw, key, secret := environment(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	id := "rvs_lost_" + strings.ReplaceAll(time.Now().UTC().Format("150405.000000000"), ".", "")
	name, client, owner := "raya-lost-"+id, "client-"+id, "media-"+id
	token := func(identity string) string {
		t.Helper()
		value, err := auth.NewAccessToken(key, secret).SetIdentity(identity).SetValidFor(time.Minute).SetVideoGrant(&auth.VideoGrant{RoomJoin: true, Room: name}).ToJWT()
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	nonce := []byte("exact-effect-" + id)
	observed := make(chan struct{})
	captured := make(chan Message, 1)
	var delivered atomic.Int32
	var once sync.Once
	peer := lksdk.NewRoom(&lksdk.RoomCallback{ParticipantCallback: lksdk.ParticipantCallback{OnDataPacket: func(packet lksdk.DataPacket, params lksdk.DataReceiveParams) {
		value, ok := packet.(*lksdk.UserDataPacket)
		if !ok || params.SenderIdentity != owner || value.Topic != "raya.receipt-loss" || !bytes.Equal(value.Payload, nonce) {
			return
		}
		delivered.Add(1)
		once.Do(func() { close(observed) })
	}}})
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
			t.Error("test SDK observer Disconnect blocked")
		}
	})
	if err := peer.JoinWithContextAndToken(ctx, raw, token(client)); err != nil {
		t.Fatal("real SFU observer join failed", err)
	}
	factory := Factory{Path: path, wrap: func(input io.Reader) io.Reader {
		return &loss{input: input, session: client, captured: captured, observed: observed}
	}}
	joined, err := factory.JoinAudioAuthorized(ctx, raw, token(owner), name, client, 24000)
	if err != nil {
		t.Fatal("actual production worker join failed", err)
	}
	var ok bool
	proxy, ok = joined.(*Proxy)
	if !ok {
		t.Fatal("actual production factory lost process owner")
	}
	item := room.Data{Topic: "raya.receipt-loss", Body: nonce}
	result := proxy.Send(ctx, item)
	if !errors.Is(result, ErrUnknown) {
		t.Fatal("unaccepted real action ACK was not retained as unknown", result)
	}
	select {
	case ack := <-captured:
		if ack.Version != Version || ack.ID != 2 || ack.Session != client || ack.Op != "ack" || ack.Outcome != "confirmed" || ack.Error != "" {
			t.Fatal("test did not capture the exact real generated child ACK")
		}
	case <-ctx.Done():
		t.Fatal("native action never generated the ACK whose receipt was lost")
	}
	select {
	case <-observed:
	case <-ctx.Done():
		t.Fatal("actual external SFU effect was not observed")
	}
	terminated(t, proxy)
	if err := proxy.Send(ctx, item); !errors.Is(err, ErrStopped) {
		t.Fatal("stopped actual child replayed an uncertain action", err)
	}
	select {
	case <-time.After(80 * time.Millisecond):
	case <-ctx.Done():
		t.Fatal("lost-receipt observation deadline")
	}
	if delivered.Load() != 1 {
		t.Fatal("unknown actual effect was replayed or duplicated")
	}
	if err := proxy.Close(); err != nil {
		t.Fatal("actual Wait receipt remained unknown", err)
	}
}
