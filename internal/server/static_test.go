package server

import (
	"html"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"agentbox/internal/buildinfo"
)

func TestStaticIndexCarriesRunningServerVersion(t *testing.T) {
	t.Setenv("AGENTBOX_WEB_DIR", "")
	handler := staticHandler()
	for _, path := range []string{"/", "/index.html"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		want := `data-server-version="` + html.EscapeString(buildinfo.Version) + `"`
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), want) {
			t.Errorf("%s did not serve the index with version %q (status %d)", path, buildinfo.Version, response.Code)
		}
	}
}
