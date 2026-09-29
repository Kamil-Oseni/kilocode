package process

import (
	"context"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"testing"
	"time"
)

func TestExitReceiptSubprocess(t *testing.T) {
	if code := os.Getenv("RAYA_TEST_EXIT_CODE"); code != "" {
		if code == "wait" {
			_, _ = os.Stdout.Write([]byte{1})
			_, _ = io.Copy(io.Discard, os.Stdin)
			os.Exit(0)
		}
		value, err := strconv.Atoi(code)
		if err != nil {
			os.Exit(99)
		}
		os.Exit(value)
	}
	for _, code := range []int{0, 7} {
		t.Run(strconv.Itoa(code), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestExitReceiptSubprocess$")
			cmd.Env = append(os.Environ(), "RAYA_TEST_EXIT_CODE="+strconv.Itoa(code))
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			p := &Proxy{done: make(chan struct{})}
			if value := p.outcome(); value.Known {
				t.Fatal("unjoined process reported an exit", value)
			}
			err := cmd.Wait()
			if (code == 0 && err != nil) || (code != 0 && err == nil) {
				t.Fatal("unexpected subprocess outcome", err)
			}
			p.exit = observed(cmd.ProcessState)
			if p.outcome().Known {
				t.Fatal("exit published before actual owner Done")
			}
			close(p.done)
			value := p.outcome()
			if !value.Known || value.Code != code || value.Signaled || value.Signal != 0 {
				t.Fatal("incorrect actual Wait receipt", value)
			}
		})
	}
	p := &Proxy{done: make(chan struct{}), exit: observed(nil)}
	close(p.done)
	if p.outcome().Known {
		t.Fatal("missing actual ProcessState manufactured an exit")
	}
}

func TestExitReceiptActualKill(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestExitReceiptSubprocess$")
	cmd.Env = append(os.Environ(), "RAYA_TEST_EXIT_CODE=wait")
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	output, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	body := make([]byte, 1)
	if _, err := io.ReadFull(output, body); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		t.Fatal(err)
	}
	if err := cmd.Process.Kill(); err != nil {
		_ = cmd.Wait()
		t.Fatal(err)
	}
	if err := cmd.Wait(); err == nil {
		t.Fatal("killed child reported successful execution")
	}
	value := observed(cmd.ProcessState)
	if !value.Known || value.Code == 0 {
		t.Fatal("missing actual killed-child receipt", value)
	}
	if runtime.GOOS != "windows" && (!value.Signaled || value.Signal == 0) {
		t.Fatal("missing actual Unix signal receipt", value)
	}
}
