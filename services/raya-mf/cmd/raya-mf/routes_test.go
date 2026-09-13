// raya_change - the actual media router enforces native capability admission
package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/app"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/control"
)

const routeToken = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY"

func TestRoutesRejectBrowserAndUnauthenticatedControl(t *testing.T) {
	key, err := control.ParseKey(routeToken)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(routes(app.NewManager(nil), key))
	defer server.Close()

	request := func(method string, path string, body string, headers map[string]string) *http.Response {
		t.Helper()
		req, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		for name, value := range headers {
			req.Header.Set(name, value)
		}
		response, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = response.Body.Close() })
		return response
	}

	browser := request(http.MethodPost, "/v1/sessions", "{}", map[string]string{"Origin": "https://example.com"})
	if browser.StatusCode != http.StatusForbidden {
		t.Fatalf("browser status = %d", browser.StatusCode)
	}
	missing := request(http.MethodPost, "/v1/sessions", "{}", nil)
	if missing.StatusCode != http.StatusUnauthorized || missing.Header.Get("WWW-Authenticate") != "Bearer" {
		t.Fatalf("missing capability status = %d", missing.StatusCode)
	}
	wrong := request(
		http.MethodPost,
		"/v1/sessions",
		"{}",
		map[string]string{
			"Authorization":    "Bearer " + routeToken,
			"X-Raya-Media-Key": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		},
	)
	if wrong.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong service key status = %d", wrong.StatusCode)
	}
	invalid := request(
		http.MethodPost,
		"/v1/sessions",
		"{",
		map[string]string{
			"Authorization":    "Bearer " + routeToken,
			"Content-Type":     "application/json",
			"X-Raya-Media-Key": routeToken,
		},
	)
	if invalid.StatusCode != http.StatusBadRequest {
		body, _ := io.ReadAll(invalid.Body)
		t.Fatalf("authenticated invalid JSON status = %d, body = %q", invalid.StatusCode, body)
	}
	missingSession := request(
		http.MethodGet,
		"/v1/sessions/rvs_missing",
		"",
		map[string]string{"Authorization": "Bearer " + routeToken, "X-Raya-Media-Key": routeToken},
	)
	if missingSession.StatusCode != http.StatusNotFound {
		t.Fatalf("authenticated missing session status = %d", missingSession.StatusCode)
	}
}
