//go:build !windows

package process

import "os/exec"

func hidden(_ *exec.Cmd) {}
