// kilocode_change - new file
package control

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func receiver(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewUnstartedServer(nil)
	server.Config = Server(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, ok := Read(writer, request)
		if !ok {
			return
		}
		if _, err := io.WriteString(writer, strconv.Itoa(len(body))); err != nil {
			t.Errorf("write accepted size: %v", err)
		}
	}))
	server.Start()
	t.Cleanup(server.Close)
	return server
}

func TestBodyLimit(t *testing.T) {
	server := receiver(t)
	client := &http.Client{Timeout: 10 * time.Second}
	for _, chunked := range []bool{false, true} {
		for _, size := range []int64{0, Limit, Limit + 1} {
			t.Run(fmt.Sprintf("chunked=%t/size=%d", chunked, size), func(t *testing.T) {
				request, err := http.NewRequest(http.MethodPost, server.URL, strings.NewReader(strings.Repeat("x", int(size))))
				if err != nil {
					t.Fatal(err)
				}
				if chunked {
					request.ContentLength = -1
				}
				response, err := client.Do(request)
				if err != nil {
					t.Fatal(err)
				}
				defer response.Body.Close()
				body, err := io.ReadAll(response.Body)
				if err != nil {
					t.Fatal(err)
				}
				if size > Limit {
					if response.StatusCode != http.StatusRequestEntityTooLarge {
						t.Fatalf("oversized request status = %d", response.StatusCode)
					}
					return
				}
				if response.StatusCode != http.StatusOK || string(body) != strconv.FormatInt(size, 10) {
					t.Fatalf("accepted request status = %d, body = %q", response.StatusCode, body)
				}
			})
		}
	}
}

func TestIncompleteBodyDeadline(t *testing.T) {
	server := receiver(t)
	connection, err := net.Dial("tcp", server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if err := connection.SetDeadline(time.Now().Add(25 * time.Second)); err != nil {
		t.Fatal(err)
	}
	// Send complete headers, then withhold the declared body. Use the actual
	// production server deadline, not a test-specific replacement timer.
	if _, err := io.WriteString(connection, "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(connection), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("incomplete body status = %d", response.StatusCode)
	}
}
