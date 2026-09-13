// kilocode_change - local media control rejects browser origins and requires capability credentials
package control

import (
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
)

type Key [32]byte

func ParseKey(value string) (Key, error) {
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(raw) != len(Key{}) {
		return Key{}, errors.New("RAYA_MF_TOKEN must be a 32-byte base64url key")
	}
	return Key(raw), nil
}

func Authorize(writer http.ResponseWriter, request *http.Request, expected Key) (string, bool) {
	service, err := ParseKey(request.Header.Get("X-Raya-Media-Key"))
	if err != nil || subtle.ConstantTimeCompare(service[:], expected[:]) != 1 {
		writer.Header().Set("WWW-Authenticate", "Bearer")
		http.Error(writer, "Media service authorization failed", http.StatusUnauthorized)
		return "", false
	}
	value := request.Header.Get("Authorization")
	token, found := strings.CutPrefix(value, "Bearer ")
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if !found || err != nil || len(raw) != 32 {
		writer.Header().Set("WWW-Authenticate", "Bearer")
		http.Error(writer, "Media control authorization failed", http.StatusUnauthorized)
		return "", false
	}
	return token, true
}

func Browser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if strings.HasPrefix(request.URL.Path, "/v1/") &&
			(request.Header.Get("Origin") != "" || request.Header.Get("Sec-Fetch-Site") != "") {
			http.Error(writer, "Browser requests are not allowed on media control routes", http.StatusForbidden)
			return
		}
		next.ServeHTTP(writer, request)
	})
}
