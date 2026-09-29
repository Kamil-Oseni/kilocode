//go:build !linux

package process

func owner() func() { return func() {} }
