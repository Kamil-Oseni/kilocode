//go:build cgo && linux

package process

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/livekit/protocol/auth"
	"golang.org/x/sys/unix"
)

// The test binary supervises ancestry only; the transport is the real production
// executable connected to the actual local SFU. No device/provider audio is used.
func TestProductionWorkerParentDeath(t *testing.T) {
	switch os.Getenv("RAYA_PARENT_TEST") {
	case "launcher":
		launch(t)
		return
	case "supervisor":
		reap(t)
		return
	}
	environment(t)
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestProductionWorkerParentDeath$", "-test.count=1")
	cmd.Env = append(os.Environ(), "RAYA_PARENT_TEST=supervisor")
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("production parent-death supervisor failed: %v\n%s", err, output)
	}
}

func launch(t *testing.T) {
	release := owner()
	defer release()
	input := os.NewFile(3, "startup")
	output := os.NewFile(4, "events")
	defer input.Close()
	defer output.Close()
	cmd := exec.Command(os.Getenv("RAYA_TEST_MEDIA_BINARY"), "--livekit-worker")
	cmd.Env = []string{"GOMAXPROCS=2"}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = input, output, io.Discard
	hidden(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatal("production worker start failed", err)
	}
	defer cmd.Process.Kill()
	if _, err := fmt.Fprintln(os.Stdout, cmd.Process.Pid); err != nil {
		t.Fatal("worker PID publication failed", err)
	}
	if err := cmd.Wait(); err != nil {
		t.Fatal("worker exited before launcher termination", err)
	}
	t.Fatal("worker exited while launcher retained its creator thread")
}

func reap(t *testing.T) {
	path, url, key, secret := environment(t)
	release := owner()
	defer release()
	// Only this disposable supervisor becomes a subreaper. The package test
	// process and other tests retain their original process ancestry semantics.
	if err := unix.Prctl(unix.PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0); err != nil {
		t.Fatal("subreaper setup failed", err)
	}
	reader, input, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer input.Close() // Remains open across parent death: EOF cannot explain exit.
	output, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer output.Close()
	defer writer.Close()
	cmd := exec.Command(os.Args[0], "-test.run=^TestProductionWorkerParentDeath$", "-test.count=1")
	cmd.Env = []string{"GOMAXPROCS=2", "RAYA_PARENT_TEST=launcher", "RAYA_TEST_MEDIA_BINARY=" + path}
	cmd.ExtraFiles = []*os.File{reader, writer}
	cmd.Stderr = io.Discard
	hidden(cmd) // An outer test timeout must also terminate this launcher ancestry.
	pidstream, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal("launcher start failed", err)
	}
	defer func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()
	_ = reader.Close()
	_ = writer.Close()
	pipe, ok := pidstream.(*os.File)
	if !ok {
		t.Fatal("launcher PID stream is not an owned OS pipe")
	}
	if err := pipe.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal("launcher PID deadline could not be applied", err)
	}
	line, err := bufio.NewReader(pidstream).ReadString('\n')
	if err != nil {
		t.Fatal("worker PID missing", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(line))
	if err != nil || pid <= 0 || pid == os.Getpid() || pid == cmd.Process.Pid {
		t.Fatal("invalid distinct production worker PID")
	}
	reaped := false
	defer func() {
		if !reaped {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			_ = syscall.Kill(pid, syscall.SIGKILL)
			end := time.Now().Add(3 * time.Second)
			for {
				var status syscall.WaitStatus
				found, err := syscall.Wait4(pid, &status, syscall.WNOHANG, nil)
				if found == pid || errors.Is(err, syscall.ECHILD) {
					break
				}
				if err != nil || time.Now().After(end) {
					t.Error("failed to reap production child within cleanup deadline", err)
					break
				}
				time.Sleep(5 * time.Millisecond)
			}
		}
	}()
	id := fmt.Sprintf("client-rvs_parent_%d", os.Getpid())
	name := fmt.Sprintf("parent-death-%d", os.Getpid())
	token, err := auth.NewAccessToken(key, secret).SetIdentity("media-" + id).SetValidFor(time.Minute).SetVideoGrant(&auth.VideoGrant{RoomJoin: true, Room: name}).ToJWT()
	if err != nil {
		t.Fatal("local SFU token creation failed")
	}
	if err := Write(input, Message{Version: Version, Session: id, ID: 1, Op: "join", Expires: time.Now().Add(15 * time.Second).UnixMilli(), Startup: &Startup{URL: url, Token: token, Name: name, Client: id, Rate: 24000}}); err != nil {
		t.Fatal("production join write failed", err)
	}
	ready := make(chan Message, 1)
	fault := make(chan error, 1)
	go func() {
		value, err := Read(output)
		if err != nil {
			fault <- err
			return
		}
		ready <- value
	}()
	select {
	case value := <-ready:
		if value.Op != "ready" || value.Outcome != "confirmed" || value.Session != id || value.ID != 1 {
			t.Fatal("production worker failed actual local SFU readiness")
		}
	case <-fault:
		t.Fatal("production worker closed before readiness")
	case <-time.After(16 * time.Second):
		t.Fatal("production SFU readiness deadline exceeded")
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal("launcher kill failed", err)
	}
	if err := cmd.Wait(); err == nil {
		t.Fatal("launcher did not terminate abnormally")
	}
	end := time.Now().Add(3 * time.Second)
	for {
		var status syscall.WaitStatus
		found, err := syscall.Wait4(pid, &status, syscall.WNOHANG, nil)
		if err != nil {
			t.Fatal("exact production child Wait4 failed", err)
		}
		if found == pid {
			reaped = true
			if !status.Signaled() || status.Signal() != syscall.SIGKILL {
				t.Fatal("worker exit was not Linux parent-death SIGKILL", status)
			}
			if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
				t.Fatal("production child remains observable after exact reap", err)
			}
			return
		}
		if time.Now().After(end) {
			t.Fatal("production worker survived creator-process death")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
