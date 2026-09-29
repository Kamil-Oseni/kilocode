//go:build linux && cgo

package process

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// Run the unchanged production-resource journey in a test subprocess, consume
// one genuinely generated native ACK before Proxy receives it, and require its
// failed artifact AFTER actual bounded owner cleanup. No retry or playback claim.
func TestProductionResourceLostACKRetainsFailedCleanupEvidence(t *testing.T) {
	environment(t)
	if os.Getenv("RAYA_RESOURCE_FAILURE_SUPERVISOR") != "1" {
		report := filepath.Join(t.TempDir(), "failed-resources.json")
		ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
		defer cancel()
		release := owner()
		defer release()
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestProductionResourceLostACKRetainsFailedCleanupEvidence$", "-test.count=1", "-test.timeout=35s")
		cmd.Env = append(os.Environ(), "RAYA_RESOURCE_FAILURE_SUPERVISOR=1", "RAYA_RESOURCE_FAILURE_REPORT="+report)
		cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
		hidden(cmd)
		err := cmd.Run()
		body, read := os.ReadFile(report)
		if read == nil && json.Valid(body) {
			t.Logf("resource_expected_failure_measurement %s", body)
		}
		if err != nil || ctx.Err() != nil {
			t.Fatal("resource fault supervisor failed bounded cleanup/evidence assertions")
		}
		return
	}
	// Only this disposable supervisor adopts a timed-out helper's transport.
	// Never change process ancestry semantics for unrelated package tests.
	if err := unix.Prctl(unix.PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0); err != nil {
		t.Fatal("resource fault supervisor cannot own orphan cleanup")
	}
	report := os.Getenv("RAYA_RESOURCE_FAILURE_REPORT")
	if !filepath.IsAbs(report) {
		t.Fatal("resource fault supervisor requires absolute artifact path")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	release := owner()
	defer release()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestProductionWorkerSustainedResources$", "-test.count=1", "-test.timeout=25s")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	hidden(cmd)
	cmd.Env = append(os.Environ(), "RAYA_TEST_PARENT_TRACE=1", "RAYA_TEST_RESOURCE_LOST_ACK=1", "RAYA_TEST_RESOURCE_SECONDS=60", "RAYA_TEST_RESOURCE_MODE=continuous", "RAYA_TEST_RESOURCE_WORKERS=", "RAYA_TEST_RESOURCE_REPORT="+report)
	// Preserve only the explicit sanitized artifact, never native stderr or
	// subprocess stack/log payloads. Run still joins the exact test subprocess.
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	err := cmd.Run()
	// Cmd.Run joined the helper. Wait4 first establishes owned adopted children
	// in its isolated group; never signal a freed numeric group after ECHILD.
	if cmd.Process != nil {
		until := time.Now().Add(4 * time.Second)
		sealed := false
		for {
			var status syscall.WaitStatus
			pid, err := syscall.Wait4(-cmd.Process.Pid, &status, syscall.WNOHANG, nil)
			if errors.Is(err, syscall.ECHILD) {
				break
			}
			if err != nil {
				t.Error("resource fault descendant reaping failed")
				break
			}
			if time.Now().After(until) {
				t.Error("resource fault descendant cleanup remains unknown")
				break
			}
			if pid == 0 {
				if !sealed {
					sealed = true
					if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
						t.Error("resource fault emergency owned group stop failed")
					}
				}
				time.Sleep(time.Millisecond)
			}
		}
	}
	var failed *exec.ExitError
	if ctx.Err() != nil || !errors.As(err, &failed) || failed.ExitCode() != 1 {
		t.Fatal("resource fault journey did not terminate as expected failed test")
	}
	body, err := os.ReadFile(report)
	if err != nil {
		t.Fatal("failed resource journey did not retain terminal artifact")
	}
	var result struct {
		Completed bool   `json:"completed"`
		Outcome   string `json:"outcome"`
		Unknown   bool   `json:"unknownPublish"`
		Lost      struct {
			Captured bool   `json:"captured"`
			ID       uint64 `json:"id"`
			Outcome  string `json:"outcome"`
		} `json:"lostAck"`
		Cleanup resourceCleanup `json:"cleanup"`
		Windows []window        `json:"rawWindows"`
		Active  float64         `json:"completedActiveSeconds"`
		Action  *observation    `json:"parentAction"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatal("failed resource artifact was malformed")
	}
	if result.Completed || result.Outcome != "failed-partial-after-bounded-cleanup" || !result.Unknown || !result.Lost.Captured || result.Lost.ID != 2 || result.Lost.Outcome != "confirmed" || result.Active != 0 {
		t.Fatal("lost genuine ACK was replayed or unknown publish acquired false completion")
	}
	if result.Action == nil || result.Action.ID != 2 || (result.Action.Stages&(1<<traceFinish) != 0 && result.Action.Outcome != 3) || result.Action.Correlated || result.Action.Consumed != 0 {
		t.Fatal("lost ACK diagnostic inferred parent acceptance or changed caller outcome")
	}
	if !result.Action.Incomplete && (!result.Action.Available || result.Action.Stages&(1<<traceWriteEnd) == 0 || !result.Action.WriteOK || result.Action.Stages&(1<<traceFinish) == 0) {
		t.Fatal("complete parent diagnostic omitted admitted write or immutable outcome")
	}
	cleanup := result.Cleanup
	if cleanup.PID <= 0 || cleanup.Start == 0 || !cleanup.Done || !cleanup.Wait || !cleanup.Absent || !cleanup.Exit.Known || !cleanup.Input || !cleanup.Observer || cleanup.Slots != 0 {
		t.Fatal("failed resource artifact lacks joined owner receipts")
	}
	if !errors.Is(syscall.Kill(cleanup.PID, 0), syscall.ESRCH) {
		t.Fatal("production transport PID survived failed test subprocess")
	}
	if len(result.Windows) != 1 || len(result.Windows[0].Children) != 1 || result.Windows[0].Children[0].PID != cleanup.PID || result.Windows[0].Children[0].Start != cleanup.Start {
		t.Fatal("terminal cleanup was not correlated to measured exact child")
	}
	if cleanup.Group["memory.events"] == "" || cleanup.Group["pids.current"] == "" {
		t.Fatal("failed resource artifact omitted final cgroup evidence")
	}
}
