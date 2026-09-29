//go:build !windows && !linux

package process

import "os/exec"

func hidden(_ *exec.Cmd) {}
