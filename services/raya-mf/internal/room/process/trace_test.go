package process

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"testing"
	"time"
)

// This peer exercises production parent call/read/write over real OS pipes.
// It is not a native transport, SFU, encoding, or playback receipt.
func TestTraceProcessPeer(t *testing.T) {
	mode := os.Getenv("RAYA_TRACE_PEER")
	if mode == "" {
		return
	}
	const session = "client-rvs_adverse"
	if err := Write(os.Stdout, Message{Version: Version, Session: session, ID: 1, Op: "ready", Outcome: "confirmed"}); err != nil {
		os.Exit(11)
	}
	if mode == "blocked" {
		time.Sleep(200 * time.Millisecond)
		os.Exit(0)
	}
	for {
		message, err := Read(os.Stdin)
		if errors.Is(err, io.EOF) {
			os.Exit(0)
		}
		if err != nil || message.Op != "flush" {
			os.Exit(12)
		}
		if mode == "missing" {
			time.Sleep(60 * time.Millisecond)
			os.Exit(0)
		}
		if mode == "late" {
			time.Sleep(60 * time.Millisecond)
		}
		id := message.ID
		if mode == "wrong" {
			id++
		}
		if err := Write(os.Stdout, Message{Version: Version, Session: session, ID: id, Op: "ack", Outcome: "confirmed"}); err != nil {
			os.Exit(13)
		}
		if mode != "confirmed" {
			os.Exit(0)
		}
	}
}

// A finite prefill at the real OS-pipe boundary makes stdio backpressure
// deterministic without emulating a native action or creating another owner.
type backpressure struct {
	input io.Writer
}

func (b backpressure) Write(value []byte) (int, error) {
	var buffer [32768]byte
	for range 128 {
		if _, err := b.input.Write(buffer[:]); err != nil {
			return 0, err
		}
	}
	return b.input.Write(value)
}

func TestTraceActualProcessBoundaries(t *testing.T) {
	for _, mode := range []string{"confirmed", "late", "wrong", "missing", "blocked"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			release := owner()
			defer release()
			cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestTraceProcessPeer$")
			cmd.Env = append(os.Environ(), "RAYA_TRACE_PEER="+mode)
			cmd.Stderr = io.Discard
			hidden(cmd)
			input, err := cmd.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			output, err := cmd.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			p := proxy()
			p.id.Store(1)
			p.trace = &trace{}
			written, read := make(chan struct{}), make(chan struct{})
			var stream io.Writer = input
			if mode == "blocked" {
				stream = backpressure{input: input}
			}
			go func() { defer close(written); p.write(stream) }()
			go func() { defer close(read); p.read(output) }()
			defer func() {
				p.halt()
				if err := input.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
					t.Error("owned stdin close refused")
				}
				joined := true
				for _, end := range []<-chan struct{}{written, read} {
					select {
					case <-end:
					case <-ctx.Done():
						joined = false
						t.Error("parent pipe owner did not join")
						if err := cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
							t.Error("owned peer termination refused")
						}
						if err := output.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
							t.Error("owned stdout close refused")
						}
					}
				}
				wait := cmd.Wait()
				receipt := observed(cmd.ProcessState)
				t.Logf("parent_trace_peer_exit mode=%s joined=%t known=%t code=%d signaled=%t signal=%d", mode, joined, receipt.Known, receipt.Code, receipt.Signaled, receipt.Signal)
				if !receipt.Known || receipt.Code != 0 || wait != nil || ctx.Err() != nil {
					t.Error("controlled peer lacks expected actual zero-exit receipt")
				}
				if err := output.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
					t.Error("terminal stdout close refused")
				}
			}()
			select {
			case <-p.ready:
			case <-ctx.Done():
				t.Fatal("actual peer did not become ready")
			}
			err = p.Flush(context.Background(), "turn")
			if mode == "confirmed" {
				if err != nil {
					t.Fatal("controlled peer acceptance failed", err)
				}
			} else if !errors.Is(err, ErrUnknown) || !p.stopped.Load() {
				t.Fatal("late or wrong ACK was not unknown and sealed", err)
			}
			before := p.trace.snapshot()
			if before.ID != 2 || before.Operation != 3 || before.Budget <= 0 {
				t.Fatal("diagnostic identity or unchanged deadline missing", before)
			}
			if mode == "blocked" && !before.Incomplete && (before.Stages&(1<<traceWriteBegin) == 0 || before.Stages&(1<<traceWriteEnd) != 0) {
				t.Fatal("real OS-pipe backpressure was not observed before unknown return", before)
			}
			if mode != "confirmed" {
				if err := p.Flush(context.Background(), "turn"); !errors.Is(err, ErrStopped) {
					t.Fatal("unknown action admitted a replay", err)
				}
			}
			if mode == "late" || mode == "wrong" || mode == "missing" {
				select {
				case <-read:
				case <-ctx.Done():
					t.Fatal("late peer observation did not join")
				}
			}
			after := p.trace.snapshot()
			want := uint8(1)
			if mode != "confirmed" {
				want = 3
			}
			if after.Stages&(1<<traceFinish) != 0 && after.Outcome != want {
				t.Fatal("late observation changed caller outcome", after)
			}
			if mode != "blocked" && !after.Incomplete && (after.Stages&(1<<traceWriteEnd) == 0 || !after.WriteOK || after.Stages&(1<<traceFinish) == 0) {
				t.Fatal("complete diagnostic omitted actual writer or caller stage", after)
			}
			if mode == "missing" && (after.Stages&(1<<traceAckParsed) != 0 || after.Correlated || after.Consumed != 0) {
				t.Fatal("missing actual ACK fabricated parent observation", after)
			}
			if mode == "wrong" && (after.Stages&(1<<traceAckParsed) != 0 || after.Correlated) {
				t.Fatal("wrong ID contaminated exact action trace", after)
			}
			if mode == "late" && !after.Incomplete && (after.Stages&(1<<traceAckParsed) == 0 || after.Correlated || after.Consumed != 0 || after.Outcome != before.Outcome) {
				t.Fatal("late exact ACK altered acceptance or immutable return", after)
			}
		})
	}
}

func TestTraceContentionAndExactReplacement(t *testing.T) {
	value := &trace{}
	start := time.Now()
	value.mu.Lock()
	value.begin(2, "flush", start, start.Add(20*time.Millisecond))
	value.mark(2, traceFinish, 3)
	missing := value.snapshot()
	value.mu.Unlock()
	if missing.Available || !missing.Incomplete || missing.ID != 2 || missing.Dropped != 2 {
		t.Fatal("contention fabricated stages", missing)
	}
	value.begin(3, "send", start, start.Add(20*time.Millisecond))
	value.mark(2, traceAckParsed, 1)
	value.mark(3, traceFinish, 3)
	value.mark(3, traceFinish, 1)
	value.mark(3, traceAckParsed, 1)
	saved := value.snapshot()
	if saved.ID != 3 || saved.Operation != 2 || saved.Outcome != 3 || saved.Ack != 1 || saved.Incomplete {
		t.Fatal("replacement or late ACK changed immutable return", saved)
	}
}
