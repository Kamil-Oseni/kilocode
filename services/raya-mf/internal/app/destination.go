// raya_change - callback credentials stay on the managed local backend origin
package app

import (
	"errors"
	"net"
	"net/url"
	"strconv"
)

func local(value string) (string, error) {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "http" || parsed.User != nil || parsed.Hostname() == "" || (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("voice backend must use a numeric loopback HTTP address")
	}
	ip := net.ParseIP(parsed.Hostname())
	if ip == nil || !ip.IsLoopback() {
		return "", errors.New("voice backend must use a numeric loopback HTTP address")
	}
	if parsed.Port() != "" {
		port, err := strconv.Atoi(parsed.Port())
		if err != nil || port < 1 || port > 65535 {
			return "", errors.New("voice backend port is invalid")
		}
	}
	parsed.Path = ""
	return parsed.String(), nil
}
