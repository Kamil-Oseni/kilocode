// raya_change - An isolated native transport with real OS process-exit receipts.
package process

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/room"
)

var ErrStopped = errors.New("isolated media transport is stopped")
var ErrUnknown = errors.New("isolated media action completion is unknown")
var ErrRefused = errors.New("isolated media action was refused")
var ErrWorker = errors.New("isolated media worker failed")
var ErrCapacity = errors.New("isolated media worker capacity reached")

// Reservations include starting, running and retiring processes. Cancellation
// cannot free a slot while its actual process or pipe owners remain unjoined.
var slots = make(chan struct{}, 8)

type Factory struct {
	Path string
	wrap func(io.Reader) io.Reader
}

func (f Factory) Join(ctx context.Context, url, token, name string) (room.Room, error) {
	return f.JoinAuthorized(ctx, url, token, name, "")
}
func (f Factory) JoinAuthorized(ctx context.Context, url, token, name, client string) (room.Room, error) {
	return f.JoinAudioAuthorized(ctx, url, token, name, client, 16000)
}
func (f Factory) JoinAudioAuthorized(ctx context.Context, url, token, name, client string, rate int) (room.Room, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	start, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	expires, _ := start.Deadline()
	message := Message{Version: Version, Session: client, ID: 1, Op: "join", Expires: expires.UnixMilli(), Startup: &Startup{URL: url, Token: token, Name: name, Client: client, Rate: rate}}
	if err := Validate(message); err != nil {
		return nil, err
	}
	path := f.Path
	if path == "" {
		var err error
		path, err = os.Executable()
		if err != nil {
			return nil, ErrWorker
		}
	}
	if !filepath.IsAbs(path) {
		return nil, ErrWorker
	}
	select {
	case slots <- struct{}{}:
	default:
		return nil, ErrCapacity
	}
	p := &Proxy{session: client, rate: rate, wrap: f.wrap, stop: make(chan struct{}), done: make(chan struct{}), ready: make(chan Message, 1), ack: make(chan Message, 1), jobs: make(chan Message), admit: make(chan struct{}, 1), input: make(chan engine.Frame, 64), data: make(chan room.Data, 64), failure: make(chan error, 1)}
	p.id.Store(1)
	watch := context.AfterFunc(ctx, p.halt)
	go p.run(path, watch)
	select {
	case <-start.Done():
		p.halt()
		return nil, &room.SetupError{Cause: start.Err(), Cleanup: p}
	case <-p.stop:
		return nil, &room.SetupError{Cause: ErrWorker, Cleanup: p}
	case p.jobs <- message:
	}
	select {
	case <-start.Done():
		p.halt()
		return nil, &room.SetupError{Cause: start.Err(), Cleanup: p}
	case <-p.stop:
		return nil, &room.SetupError{Cause: ErrWorker, Cleanup: p}
	case ready := <-p.ready:
		if start.Err() != nil || p.stopped.Load() {
			p.halt()
			return nil, &room.SetupError{Cause: errors.Join(start.Err(), ErrStopped), Cleanup: p}
		}
		if ready.Outcome != "confirmed" {
			p.halt()
			return nil, &room.SetupError{Cause: ErrRefused, Cleanup: p}
		}
		return p, nil
	}
}

type Proxy struct {
	session  string
	rate     int
	wrap     func(io.Reader) io.Reader
	pid      atomic.Int64
	id       atomic.Uint64
	pending  atomic.Uint64
	queued   atomic.Int32
	stopped  atomic.Bool
	once     sync.Once
	reported sync.Once
	stop     chan struct{}
	done     chan struct{}
	ready    chan Message
	ack      chan Message
	jobs     chan Message
	admit    chan struct{}
	input    chan engine.Frame
	data     chan room.Data
	failure  chan error
	err      error // Published by closing done; action uncertainty is kept separate.
}

func (p *Proxy) PID() int              { return int(p.pid.Load()) }
func (p *Proxy) Done() <-chan struct{} { return p.done }
func (p *Proxy) Err() error {
	select {
	case <-p.done:
		return p.err
	default:
		return room.ErrCleanupUnknown
	}
}
func (p *Proxy) Input() <-chan engine.Frame { return p.input }
func (p *Proxy) Data() <-chan room.Data     { return p.data }
func (p *Proxy) Failure() <-chan error      { return p.failure }
func (p *Proxy) halt()                      { p.once.Do(func() { p.stopped.Store(true); close(p.stop) }) }
func (p *Proxy) fail() {
	p.halt()
	p.reported.Do(func() {
		select {
		case p.failure <- ErrWorker:
		default:
		}
	})
}

func (p *Proxy) run(path string, watch func() bool) {
	release := owner()
	reaped := true
	defer func() {
		watch()
		release()
		if reaped {
			<-slots
		}
		close(p.done)
	}()
	reader, input, err := os.Pipe()
	if err != nil {
		p.fail()
		return
	}
	defer reader.Close()
	defer input.Close()
	output, writer, err := os.Pipe()
	if err != nil {
		p.fail()
		return
	}
	defer output.Close()
	defer writer.Close()
	cmd := exec.Command(path, "--livekit-worker")
	// Native transport receives no provider/backend credentials or user config.
	cmd.Env = []string{"GOMAXPROCS=2"}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = reader, writer, io.Discard
	hidden(cmd)
	if p.stopped.Load() {
		return
	}
	if err := cmd.Start(); err != nil {
		p.fail()
		return
	}
	p.pid.Store(int64(cmd.Process.Pid))
	_ = reader.Close()
	_ = writer.Close()
	written, read, waited := make(chan struct{}), make(chan struct{}), make(chan struct{})
	go func() {
		defer close(written)
		for {
			select {
			case <-p.stop:
				return
			case message := <-p.jobs:
				if p.stopped.Load() {
					return
				}
				if err := Write(input, message); err != nil {
					p.fail()
					return
				}
			}
		}
	}()
	go func() {
		defer close(read)
		var stream io.Reader = output
		if p.wrap != nil {
			stream = p.wrap(stream)
		}
		p.read(stream)
	}()
	go func() {
		_ = cmd.Wait()
		// ProcessState exists only after the OS waiter reaped this exact child.
		// Exit status alone never changes a prior unknown action outcome.
		if cmd.ProcessState == nil {
			p.err = room.ErrCleanupUnknown
		}
		close(waited)
	}()
	select {
	case <-waited:
		if !p.stopped.Load() {
			p.fail()
		}
	case <-p.stop:
		// EOF requests graceful child shutdown without queuing another native
		// action behind a potentially blocked writer. One owner escalates once.
		_ = input.Close()
		timer := time.NewTimer(40 * time.Millisecond)
		select {
		case <-waited:
		case <-timer.C:
			_ = cmd.Process.Kill()
			<-waited
		}
		timer.Stop()
	}
	_ = input.Close()
	_ = output.Close()
	<-written
	<-read
	reaped = cmd.ProcessState != nil
}

func (p *Proxy) read(output io.Reader) {
	started := false
	for {
		message, err := Read(output)
		if err != nil {
			if !p.stopped.Load() {
				p.fail()
			}
			return
		}
		if p.stopped.Load() {
			return
		}
		if message.Session != p.session {
			p.fail()
			return
		}
		switch message.Op {
		case "ready":
			if started || message.ID != 1 {
				p.fail()
				return
			}
			started = true
			p.ready <- message
		case "ack":
			if !started || !p.pending.CompareAndSwap(message.ID, 0) {
				p.fail()
				return
			}
			select {
			case p.ack <- message:
			default:
				p.fail()
				return
			}
		case "input":
			if !started || message.Frame.Rate != p.rate {
				p.fail()
				return
			}
			select {
			case p.input <- *message.Frame:
			default:
				p.fail()
				return
			}
		case "data":
			if !started || message.Data.Identity != p.session {
				p.fail()
				return
			}
			select {
			case p.data <- *message.Data:
			default:
				p.fail()
				return
			}
		default:
			p.fail()
			return
		}
	}
}

func (p *Proxy) call(ctx context.Context, message Message) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if p.stopped.Load() {
		return ErrStopped
	}
	ctx, cancel := context.WithTimeout(ctx, engine.FramePeriod)
	defer cancel()
	// PCM, transcript and interruption lanes share one request/ACK owner.
	// Wait within the original deadline with at most four admitted callers;
	// ordinary overlap must not become an immediate global busy refusal.
	if p.queued.Add(1) > 4 {
		p.queued.Add(-1)
		return ErrRefused
	}
	defer p.queued.Add(-1)
	select {
	case p.admit <- struct{}{}:
		defer func() { <-p.admit }()
	case <-ctx.Done():
		return ctx.Err()
	case <-p.stop:
		return ErrStopped
	}
	if p.stopped.Load() {
		return ErrStopped
	}
	expires, _ := ctx.Deadline()
	message.Version, message.Session, message.ID, message.Expires = Version, p.session, p.id.Add(1), expires.UnixMilli()
	if err := Validate(message); err != nil {
		return errors.Join(ErrRefused, err)
	}
	p.pending.Store(message.ID)
	defer p.pending.Store(0)
	select {
	case <-ctx.Done():
		return ctx.Err() // No writer accepted it.
	case <-p.stop:
		return ErrStopped
	case p.jobs <- message:
	}
	select {
	case <-ctx.Done():
		p.halt()
		return errors.Join(ErrUnknown, ctx.Err())
	case <-p.stop:
		return ErrUnknown
	case ack := <-p.ack:
		if ack.ID != message.ID || ctx.Err() != nil || p.stopped.Load() {
			p.halt()
			return ErrUnknown
		}
		switch ack.Outcome {
		case "confirmed":
			return nil // Local handoff only, never playback.
		case "refused":
			return ErrRefused
		default:
			p.halt()
			return ErrUnknown
		}
	}
}
func (p *Proxy) Publish(ctx context.Context, frame engine.Frame) error {
	if len(frame.PCM) != 960 {
		return ErrRefused
	}
	frame.PCM = append([]byte(nil), frame.PCM...)
	return p.call(ctx, Message{Op: "publish", Frame: &frame})
}
func (p *Proxy) Send(ctx context.Context, data room.Data) error {
	if len(data.Body) == 0 || len(data.Body) > 15360 {
		return ErrRefused
	}
	data.Body = append([]byte(nil), data.Body...)
	return p.call(ctx, Message{Op: "send", Data: &data})
}
func (p *Proxy) Flush(ctx context.Context, turn string) error {
	return p.call(ctx, Message{Op: "flush", Turn: turn})
}
func (p *Proxy) Close() error {
	p.halt()
	timer := time.NewTimer(40 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-p.done:
		return p.err
	case <-timer.C:
		return room.ErrCleanupUnknown
	}
}
