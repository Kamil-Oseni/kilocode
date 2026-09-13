// raya_change - non-loopback control listeners require an explicit deployment decision
package main

import (
	"errors"
	"net"
)

const (
	defaultAddress = "127.0.0.1:7890"
	remoteFlag     = "1"
)

func address(value string, allow string) (string, error) {
	if value == "" {
		value = defaultAddress
	}
	host, _, err := net.SplitHostPort(value)
	if err != nil {
		return "", err
	}
	ip := net.ParseIP(host)
	if ip != nil && ip.IsLoopback() {
		return value, nil
	}
	if allow == remoteFlag {
		return value, nil
	}
	return "", errors.New("non-loopback media listener requires RAYA_MF_ALLOW_NON_LOOPBACK=1")
}
