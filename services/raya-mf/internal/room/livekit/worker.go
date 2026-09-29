//go:build cgo

// raya_change - Private bounded stdio worker; process exit is the SDK termination receipt.
package livekit

import (
	"context"
	"errors"
	"io"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/room"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/room/process"
)

type request struct {
	message process.Message
	err     error
}
type emission struct {
	message process.Message
	done    chan error
}

// Worker receives credentials only through its initial bounded stdin frame.
// Returning ends the production child process, including opaque SDK owners;
// neither an operation ACK nor native Close establishes that exit receipt.
func Worker(input io.ReadCloser, output io.WriteCloser) error {
	if input == nil || output == nil {
		return errors.New("invalid")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	lifetime, stop := context.WithCancel(ctx)
	defer stop()
	defer input.Close()
	defer output.Close()
	requests := make(chan request, 1)
	emissions := make(chan emission, 8)
	failures := make(chan error, 1)
	go func() {
		for {
			message, err := process.Read(input)
			select {
			case requests <- request{message: message, err: err}:
			case <-ctx.Done():
				return
			}
			if err != nil {
				return
			}
		}
	}()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case job := <-emissions:
				err := process.Write(output, job.message)
				if job.done != nil {
					job.done <- err
				}
				if err != nil {
					select {
					case failures <- errors.New("io"):
					default:
					}
					cancel()
					return
				}
			}
		}
	}()
	send := func(message process.Message, wait bool) error {
		var done chan error
		if wait {
			done = make(chan error, 1)
		}
		select {
		case emissions <- emission{message: message, done: done}:
		default:
			cancel()
			return errors.New("busy")
		}
		if !wait {
			return nil
		}
		timer := time.NewTimer(20 * time.Millisecond)
		defer timer.Stop()
		select {
		case err := <-done:
			return err
		case <-timer.C:
			cancel()
			return errors.New("io")
		case <-ctx.Done():
			return errors.New("io")
		}
	}
	var first process.Message
	select {
	case event := <-requests:
		if event.err != nil {
			return errors.New("io")
		}
		first = event.message
	case <-ctx.Done():
		return errors.New("io")
	}
	if first.Op != "join" || first.ID != 1 || first.Startup == nil || first.Session != first.Startup.Client {
		return errors.New("invalid")
	}
	now := time.Now()
	expires := time.UnixMilli(first.Expires)
	if !expires.After(now) {
		_ = send(process.Message{Version: process.Version, Session: first.Session, ID: 1, Op: "ready", Outcome: "refused", Error: "setup"}, true)
		return errors.New("expired")
	}
	duration := min(time.Until(expires), 15*time.Second)
	timer := time.NewTimer(duration)
	defer timer.Stop()
	type joined struct {
		room room.Room
		err  error
	}
	joinedroom := make(chan joined, 1)
	startup := *first.Startup
	go func() {
		value, err := (Factory{}).JoinAudioAuthorized(lifetime, startup.URL, startup.Token, startup.Name, startup.Client, startup.Rate)
		joinedroom <- joined{room: value, err: err}
	}()
	var value room.Room
	select {
	case result := <-joinedroom:
		if result.err != nil || result.room == nil {
			_ = send(process.Message{Version: process.Version, Session: first.Session, ID: 1, Op: "ready", Outcome: "refused", Error: "setup"}, true)
			return errors.New("setup")
		}
		value = result.room
	case <-timer.C:
		_ = send(process.Message{Version: process.Version, Session: first.Session, ID: 1, Op: "ready", Outcome: "refused", Error: "setup"}, true)
		return errors.New("setup")
	case <-requests:
		// EOF, Stop, or premature commands abandon setup. The parent waits actual
		// child exit; this never claims its pending native join has already drained.
		return errors.New("stopped")
	case <-ctx.Done():
		return errors.New("io")
	}
	timer.Stop()
	defer func() { stop(); _ = value.Close() }()
	if ctx.Err() != nil || !expires.After(time.Now()) {
		_ = send(process.Message{Version: process.Version, Session: first.Session, ID: 1, Op: "ready", Outcome: "refused", Error: "setup"}, true)
		return errors.New("setup")
	}
	var faults <-chan error
	if transport, ok := value.(room.Faults); ok {
		faults = transport.Failure()
	}
	select {
	case <-faults:
		_ = send(process.Message{Version: process.Version, Session: first.Session, ID: 1, Op: "ready", Outcome: "refused", Error: "setup"}, true)
		return errors.New("native")
	default:
	}
	if err := send(process.Message{Version: process.Version, Session: first.Session, ID: 1, Op: "ready", Outcome: "confirmed"}, false); err != nil {
		return errors.New("io")
	}
	id := uint64(1)
	for {
		select {
		case <-ctx.Done():
			return errors.New("io")
		case <-failures:
			return errors.New("io")
		case <-faults:
			_ = send(process.Message{Version: process.Version, Session: first.Session, Op: "failure", Error: "native"}, true)
			return errors.New("native")
		case frame, ok := <-value.Input():
			if !ok {
				return errors.New("closed")
			}
			if err := send(process.Message{Version: process.Version, Session: first.Session, Op: "input", Frame: &frame}, false); err != nil {
				return errors.New("busy")
			}
		case data, ok := <-value.Data():
			if !ok {
				return errors.New("closed")
			}
			if err := send(process.Message{Version: process.Version, Session: first.Session, Op: "data", Data: &data}, false); err != nil {
				return errors.New("busy")
			}
		case event := <-requests:
			if event.err != nil {
				return errors.New("io")
			}
			command := event.message
			if command.Session != first.Session || command.ID <= id || command.Op == "join" {
				return errors.New("invalid")
			}
			id = command.ID
			ack := process.Message{Version: process.Version, Session: first.Session, ID: id, Op: "ack", Outcome: "refused"}
			if !time.UnixMilli(command.Expires).After(time.Now()) {
				ack.Error = "expired"
				if err := send(ack, false); err != nil {
					return errors.New("io")
				}
				continue
			}
			if command.Op == "stop" {
				// Local admission is fenced before the ACK. Only parent Cmd.Wait proves
				// full SDK exit; an opaque native cleanup receipt does not prevent exit.
				cancel()
				_ = value.Close()
				ack.Outcome = "confirmed"
				ack.Error = ""
				_ = send(ack, true)
				return nil
			}
			if (command.Op == "publish" && command.Frame == nil) || (command.Op == "send" && command.Data == nil) || (command.Op != "publish" && command.Op != "send" && command.Op != "flush") {
				ack.Error = "invalid"
				_ = send(ack, true)
				return errors.New("invalid")
			}
			if (command.Op == "publish" && (command.Frame.Rate != 24000 || len(command.Frame.PCM) != 960)) ||
				(command.Op == "send" && (len(command.Data.Body) == 0 || len(command.Data.Body) > 15360 || len(command.Data.Topic) == 0 || len(command.Data.Topic) > 128)) {
				ack.Error = "invalid"
				if err := send(ack, false); err != nil {
					return errors.New("io")
				}
				continue
			}
			call, end := context.WithDeadline(lifetime, time.UnixMilli(command.Expires))
			bounded, finish := context.WithTimeout(call, 20*time.Millisecond)
			if bounded.Err() != nil {
				finish()
				end()
				ack.Error = "expired"
				if err := send(ack, false); err != nil {
					return errors.New("io")
				}
				continue
			}
			var err error
			switch command.Op {
			case "publish":
				err = value.Publish(bounded, *command.Frame)
			case "send":
				err = value.Send(bounded, *command.Data)
			case "flush":
				err = value.Flush(bounded, command.Turn)
			}
			finish()
			end()
			if err == nil {
				ack.Outcome = "confirmed"
				ack.Error = ""
				if err := send(ack, false); err != nil {
					return errors.New("io")
				}
				continue
			}
			// The native call may already have an external effect. Never replay it.
			ack.Outcome = "unknown"
			ack.Error = "unknown"
			_ = send(ack, true)
			return errors.New("native")
		}
	}
}
