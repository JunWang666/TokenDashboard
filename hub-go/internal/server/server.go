// Package server wires the hub's HTTP routes: public health check, CORS and
// the authenticated /api/v1/ subtree. Feature handlers (ingest, query,
// credentials, settings, push, notify) register their routes in registerRoutes;
// the background collect/sweep/dispatch loop lives in loop.go.
package server

import (
	"log/slog"
	"net/http"
	"sync"
	"time"

	"tokendash/hub/internal/apperr"
	"tokendash/hub/internal/auth"
	"tokendash/hub/internal/config"
	"tokendash/hub/internal/crypto"
	"tokendash/hub/internal/push"
	"tokendash/hub/internal/store"
)

// Server bundles the shared dependencies every handler needs.
type Server struct {
	Cfg   *config.Config
	Store *store.Store
	Crypt *crypto.Crypto
	Log   *slog.Logger

	// Collector is the quota-collection hook run by RunBackground; nil skips
	// collection (see loop.go). Populated by cmd/hub via NewCollector.
	Collector Collector

	pusherOnce sync.Once
	pusher     *push.Sender
}

// pushSender builds the platform push sender lazily from configuration.
func (s *Server) pushSender() *push.Sender {
	s.pusherOnce.Do(func() {
		s.pusher = push.NewSender(s.Cfg, s.Log)
	})
	return s.pusher
}

// Handler assembles the full HTTP handler: /healthz is public, everything
// under /api/v1/ passes through auth.Middleware first.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealthz)

	api := http.NewServeMux()
	s.registerRoutes(api) // feature routes register here in later phases

	authMW := auth.Middleware(s.Cfg, s.Log)
	mux.Handle("/api/v1/", cors(s.Cfg, authMW(api)))
	// 手动触发一轮额度采集（与 TS 一样在 /api/v1/ 之外，经 auth 中间件保护）。
	mux.Handle("/__trigger", cors(s.Cfg, authMW(http.HandlerFunc(s.handleTrigger))))

	return mux
}

// require returns a middleware restricting handlers to the given roles.
// Usage inside registerRoutes: mux.Handle("POST /api/v1/usage", s.require(auth.RoleClient)(h))
func (s *Server) require(roles ...auth.Role) func(http.Handler) http.Handler {
	return func(h http.Handler) http.Handler {
		return auth.RequireRole(h, roles...)
	}
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	apperr.WriteJSON(w, http.StatusOK, map[string]any{
		"ok": true,
		"ts": time.Now().UTC().Format(time.RFC3339),
	})
}

// cors applies the CORS_ORIGINS policy: an empty configured list reflects any
// origin (same-origin / personal deployments), otherwise only listed origins
// are allowed. Applied around the authenticated API subtree only.
func cors(cfg *config.Config, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		allow := ""
		if len(cfg.CORSOrigins) == 0 {
			allow = origin // reflect any origin when unconfigured
		} else {
			for _, o := range cfg.CORSOrigins {
				if o == origin {
					allow = origin
					break
				}
			}
		}
		if allow != "" {
			w.Header().Set("Access-Control-Allow-Origin", allow)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Cf-Access-Jwt-Assertion, X-Tokendash-Internal")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
