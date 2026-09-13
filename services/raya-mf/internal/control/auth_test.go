// kilocode_change - real HTTP boundaries reject browser and missing/invalid capability credentials
package control

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

const testToken = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY"

func TestAuthorize(t *testing.T) {
	key, err := ParseKey(testToken)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name  string
		value string
		ok    bool
	}{
		{name: "valid", value: "Bearer " + testToken, ok: true},
		{name: "missing"},
		{name: "wrong scheme", value: "Basic " + testToken},
		{name: "short", value: "Bearer YQ"},
		{name: "malformed", value: "Bearer not+base64"},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/v1/sessions", nil)
			request.Header.Set("X-Raya-Media-Key", testToken)
			request.Header.Set("Authorization", test.value)
			writer := httptest.NewRecorder()
			token, ok := Authorize(writer, request, key)
			if ok != test.ok {
				t.Fatalf("authorize = %t, want %t", ok, test.ok)
			}
			if ok && token != testToken {
				t.Fatal("valid capability changed")
			}
			if !ok && writer.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d", writer.Code)
			}
		})
	}
}

func TestAuthorizeRejectsWrongServiceKey(t *testing.T) {
	key, err := ParseKey(testToken)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/sessions", nil)
	request.Header.Set("X-Raya-Media-Key", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	request.Header.Set("Authorization", "Bearer "+testToken)
	writer := httptest.NewRecorder()
	if _, ok := Authorize(writer, request, key); ok || writer.Code != http.StatusUnauthorized {
		t.Fatalf("wrong service key status = %d, authorized = %t", writer.Code, ok)
	}
}

func TestBrowser(t *testing.T) {
	hits := 0
	handler := Browser(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		hits++
		writer.WriteHeader(http.StatusNoContent)
	}))
	for _, header := range []string{"Origin", "Sec-Fetch-Site"} {
		request := httptest.NewRequest(http.MethodPost, "/v1/sessions", nil)
		request.Header.Set(header, "https://example.com")
		writer := httptest.NewRecorder()
		handler.ServeHTTP(writer, request)
		if writer.Code != http.StatusForbidden {
			t.Fatalf("%s status = %d", header, writer.Code)
		}
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/sessions", nil)
	writer := httptest.NewRecorder()
	handler.ServeHTTP(writer, request)
	if writer.Code != http.StatusNoContent || hits != 1 {
		t.Fatalf("native request status = %d, hits = %d", writer.Code, hits)
	}
}
