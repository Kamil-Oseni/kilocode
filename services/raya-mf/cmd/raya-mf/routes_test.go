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

func TestResultRouteStrictVersionAndCapability(t *testing.T) {
	key, err := control.ParseKey(routeToken)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(routes(app.NewManager(nil), key))
	defer server.Close()
	for _, test := range []struct {
		body, origin, key, token string
		status                   int
	}{
		{body: `{"version":1}`, status: http.StatusUnauthorized},
		{body: `{"version":1}`, key: routeToken, token: routeToken, origin: "https://example.com", status: http.StatusForbidden},
		{body: `{"version":3}`, key: routeToken, token: routeToken, status: http.StatusBadRequest},
		{body: `{"version":2}`, key: routeToken, token: routeToken, status: http.StatusConflict},
		{body: `{"version":2,"unknown":true}`, key: routeToken, token: routeToken, status: http.StatusBadRequest},
		{body: `{"version":2} {}`, key: routeToken, token: routeToken, status: http.StatusBadRequest},
		{body: `{"version":1,"unknown":true}`, key: routeToken, token: routeToken, status: http.StatusBadRequest},
		{body: `{"version":1} {}`, key: routeToken, token: routeToken, status: http.StatusBadRequest},
		{body: `{"version":1,"delegationID":"del","receiptID":"receipt","kind":"commentary","content":"result","ttl":1000,"created":"2026-09-28T00:00:00Z"}`, key: routeToken, token: routeToken, status: http.StatusConflict},
	} {
		request, err := http.NewRequest(http.MethodPost, server.URL+"/v1/sessions/missing/result", strings.NewReader(test.body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("X-Raya-Media-Key", test.key)
		if test.token != "" {
			request.Header.Set("Authorization", "Bearer "+test.token)
		}
		if test.origin != "" {
			request.Header.Set("Origin", test.origin)
		}
		response, err := server.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode != test.status {
			t.Fatalf("result route status %d want %d", response.StatusCode, test.status)
		}
	}
}
