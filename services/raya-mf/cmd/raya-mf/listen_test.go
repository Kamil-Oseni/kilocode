// raya_change - listener exposure cannot change through RAYA_MF_ADDR alone
package main

import "testing"

func TestAddress(t *testing.T) {
	tests := []struct {
		name  string
		value string
		allow string
		want  string
		fail  bool
	}{
		{name: "default", want: defaultAddress},
		{name: "ipv4 loopback", value: "127.4.5.6:7890", want: "127.4.5.6:7890"},
		{name: "ipv6 loopback", value: "[::1]:7890", want: "[::1]:7890"},
		{name: "wildcard refused", value: "0.0.0.0:7890", fail: true},
		{name: "ipv6 wildcard refused", value: "[::]:7890", fail: true},
		{name: "lan refused", value: "192.168.1.20:7890", fail: true},
		{name: "hostname refused", value: "localhost:7890", fail: true},
		{name: "malformed refused", value: "127.0.0.1", fail: true},
		{name: "wrong flag refused", value: "0.0.0.0:7890", allow: "true", fail: true},
		{name: "explicit wildcard", value: "0.0.0.0:7890", allow: remoteFlag, want: "0.0.0.0:7890"},
		{name: "explicit hostname", value: "container-name:7890", allow: remoteFlag, want: "container-name:7890"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := address(test.value, test.allow)
			if test.fail {
				if err == nil {
					t.Fatalf("expected %q to be refused", test.value)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != test.want {
				t.Fatalf("got %q, want %q", got, test.want)
			}
		})
	}
}
