package server

import "net/http"

// registerRoutes mounts all feature routes on the authenticated /api/v1/
// subtree, grouped by handler file:
//
//   - ingest.go:      POST /ingest/usage (user|client|runner), POST /ingest/quota (runner)
//   - query.go:       summary/bootstrap/timeseries/quota/devices (user|client)
//   - credentials.go: credentials CRUD (user|client; DELETE user-only) + internal list (runner)
//   - settings.go:    collect-webhook get (user|client) / put (user)
//   - push.go:        push subscriptions CRUD/status/test (user|client) + alerts settings get (user|client) / put (user)
//   - notify.go:      notify-channels get (user|client) / put (user)
//
// Handlers read identity via auth.PrincipalFrom(r.Context()) and shared
// dependencies via the Server receiver (s.Cfg, s.Store.DB(), s.Crypt, s.Log).
func (s *Server) registerRoutes(mux *http.ServeMux) {
	s.registerIngest(mux)
	s.registerQuery(mux)
	s.registerCredentials(mux)
	s.registerSettings(mux)
	s.registerPush(mux)
	s.registerNotify(mux)
	s.registerCollect(mux)
}
