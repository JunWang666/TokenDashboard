// Package auth implements the hub's four-strategy authentication middleware
// (Cloudflare Access JWT, internal shared credential, dev bearer token,
// Logto OIDC JWT) and role-based authorization.
package auth

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/lestrrat-go/jwx/v2/jwa"
	"github.com/lestrrat-go/jwx/v2/jwk"
	"github.com/lestrrat-go/jwx/v2/jws"
	"github.com/lestrrat-go/jwx/v2/jwt"

	"tokendash/hub/internal/config"
)

// Role identifies what an authenticated principal may do.
type Role int

const (
	// RoleUser is a human user (browser session, dev token, Logto user).
	RoleUser Role = iota
	// RoleClient is a user-facing client device (headless collector client).
	RoleClient
	// RoleRunner is the quota collector / internal service.
	RoleRunner
)

// String returns the wire name of the role ("user", "client", "runner").
func (r Role) String() string {
	switch r {
	case RoleUser:
		return "user"
	case RoleClient:
		return "client"
	case RoleRunner:
		return "runner"
	default:
		return "unknown"
	}
}

// Principal is the authenticated identity attached to the request context.
type Principal struct {
	Role  Role
	Name  string
	Email string
}

type principalKey struct{}

// PrincipalFrom returns the Principal stored in ctx by the auth middleware.
func PrincipalFrom(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(principalKey{}).(Principal)
	return p, ok
}

const jwkTTL = 6 * time.Hour

// jwkCache caches fetched JWK sets per URL for jwkTTL, with a simple
// singleflight so concurrent misses trigger one fetch.
type jwkCache struct {
	mu       sync.Mutex
	entries  map[string]jwkCacheEntry
	inflight map[string]*jwkCall
}

type jwkCacheEntry struct {
	keys      jwk.Set
	fetchedAt time.Time
}

type jwkCall struct {
	wg  sync.WaitGroup
	set jwk.Set
	err error
}

func newJWKCache() *jwkCache {
	return &jwkCache{
		entries:  make(map[string]jwkCacheEntry),
		inflight: make(map[string]*jwkCall),
	}
}

func (c *jwkCache) get(ctx context.Context, url string) (jwk.Set, error) {
	c.mu.Lock()
	if e, ok := c.entries[url]; ok && time.Since(e.fetchedAt) < jwkTTL {
		s := e.keys
		c.mu.Unlock()
		return s, nil
	}
	if call, ok := c.inflight[url]; ok {
		c.mu.Unlock()
		call.wg.Wait()
		return call.set, call.err
	}
	call := &jwkCall{}
	call.wg.Add(1)
	c.inflight[url] = call
	c.mu.Unlock()

	call.set, call.err = jwk.Fetch(ctx, url)

	call.wg.Done()
	c.mu.Lock()
	delete(c.inflight, url)
	if call.err == nil {
		c.entries[url] = jwkCacheEntry{keys: call.set, fetchedAt: time.Now()}
	}
	c.mu.Unlock()
	return call.set, call.err
}

// Middleware authenticates every request it wraps by trying, in order:
// Cloudflare Access JWT, internal shared credential, dev bearer token,
// Logto OIDC JWT. On success the Principal is stored in the request context;
// on total failure it writes 401 {"error":"unauthorized"}.
func Middleware(cfg *config.Config, log *slog.Logger) func(http.Handler) http.Handler {
	cache := newJWKCache()
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var p *Principal
			var err error

			if jwt := r.Header.Get("Cf-Access-Jwt-Assertion"); jwt != "" {
				p, err = accessPrincipal(r.Context(), cfg, cache, jwt)
				logErr(log, "cloudflare access auth", err)
			}
			if p == nil {
				p = internalPrincipal(cfg, r)
			}
			if p == nil {
				p = devPrincipal(cfg, r)
			}
			if p == nil && cfg.LogtoEndpoint != "" {
				p, err = logtoPrincipal(r.Context(), cfg, cache, r.Header.Get("Authorization"))
				logErr(log, "logto auth", err)
			}

			if p == nil {
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				w.WriteHeader(http.StatusUnauthorized)
				fmt.Fprint(w, `{"error":"unauthorized"}`+"\n")
				return
			}
			ctx := context.WithValue(r.Context(), principalKey{}, *p)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func logErr(log *slog.Logger, what string, err error) {
	if err != nil && log != nil {
		log.Debug(what+" failed", "err", err)
	}
}

// RequireRole wraps h, rejecting requests whose principal lacks one of roles
// with 403 {"error":"forbidden","required":[...]}.
func RequireRole(h http.Handler, roles ...Role) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, ok := PrincipalFrom(r.Context())
		if !ok || !roleAllowed(p.Role, roles) {
			names := make([]string, len(roles))
			for i, role := range roles {
				names[i] = role.String()
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusForbidden)
			fmt.Fprintf(w, `{"error":"forbidden","required":%q}`+"\n", names)
			return
		}
		h.ServeHTTP(w, r)
	})
}

func roleAllowed(have Role, roles []Role) bool {
	for _, r := range roles {
		if have == r {
			return true
		}
	}
	return false
}

// --- Strategy 1: Cloudflare Access JWT ---

func accessPrincipal(ctx context.Context, cfg *config.Config, cache *jwkCache, raw string) (*Principal, error) {
	// Fail closed until Access is configured.
	if cfg.AccessTeam == "" || cfg.AccessAUD == "" {
		return nil, fmt.Errorf("ACCESS_TEAM/ACCESS_AUD not configured")
	}

	msg, err := jws.ParseString(raw)
	if err != nil || len(msg.Signatures()) == 0 {
		return nil, fmt.Errorf("parse jwt: %w", err)
	}
	hdr := msg.Signatures()[0].ProtectedHeaders()
	kid := hdr.KeyID()
	if kid == "" {
		return nil, fmt.Errorf("missing kid")
	}

	claims, err := verifyJWT(ctx, cache, raw, hdr.Algorithm(), kid,
		fmt.Sprintf("https://%s.cloudflareaccess.com/cdn-cgi/access/certs", cfg.AccessTeam),
		jwt.WithAudience(cfg.AccessAUD))
	if err != nil {
		return nil, err
	}

	if email, _ := claims.Get("email"); email != nil {
		if s, ok := email.(string); ok && s != "" {
			return &Principal{Role: RoleUser, Name: s, Email: s}, nil
		}
	}
	cn, _ := claims.Get("common_name")
	cnStr, _ := cn.(string)
	if cnStr == "" {
		return nil, fmt.Errorf("no email or common_name")
	}
	for _, name := range cfg.RunnerServiceTokens {
		if name == cnStr {
			return &Principal{Role: RoleRunner, Name: cnStr}, nil
		}
	}
	if cnStr == "tokendash-headless" || strings.HasPrefix(cnStr, "headless") {
		return &Principal{Role: RoleClient, Name: cnStr}, nil
	}
	return nil, fmt.Errorf("unknown service token %q", cnStr)
}

// --- Strategy 2: internal shared credential ---

func internalPrincipal(cfg *config.Config, r *http.Request) *Principal {
	if cfg.CredentialsKey == "" {
		return nil
	}
	if r.Header.Get("X-Tokendash-Internal") != cfg.CredentialsKey {
		return nil
	}
	return &Principal{Role: RoleRunner, Name: "internal-runner"}
}

// --- Strategy 3: dev bearer token ---

func devPrincipal(cfg *config.Config, r *http.Request) *Principal {
	if cfg.DevToken == "" {
		return nil
	}
	auth := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(auth, prefix) {
		return nil
	}
	tok := strings.TrimPrefix(auth, prefix)
	switch tok {
	case cfg.DevToken:
		return &Principal{Role: RoleUser, Name: "dev"}
	case cfg.DevToken + ":runner":
		return &Principal{Role: RoleRunner, Name: "dev-runner"}
	case cfg.DevToken + ":client":
		return &Principal{Role: RoleClient, Name: "dev-client"}
	default:
		return nil
	}
}

// --- Strategy 4: Logto OIDC JWT ---

func logtoPrincipal(ctx context.Context, cfg *config.Config, cache *jwkCache, authHeader string) (*Principal, error) {
	const prefix = "Bearer "
	if !strings.HasPrefix(authHeader, prefix) {
		return nil, nil
	}
	raw := strings.TrimPrefix(authHeader, prefix)
	if len(strings.Split(raw, ".")) != 3 {
		return nil, nil // not a JWT; probably a dev token handled above
	}

	msg, err := jws.ParseString(raw)
	if err != nil || len(msg.Signatures()) == 0 {
		return nil, fmt.Errorf("parse jwt: %w", err)
	}
	hdr := msg.Signatures()[0].ProtectedHeaders()
	kid := hdr.KeyID()
	if kid == "" {
		return nil, fmt.Errorf("missing kid")
	}

	claims, err := verifyJWT(ctx, cache, raw, hdr.Algorithm(), kid,
		strings.TrimSuffix(cfg.LogtoEndpoint, "/")+"/jwks",
		jwt.WithIssuer(cfg.LogtoEndpoint),
		jwt.WithAudience(cfg.LogtoAudience))
	if err != nil {
		return nil, err
	}

	for _, key := range []string{"email", "username", "sub"} {
		if v, _ := claims.Get(key); v != nil {
			if s, ok := v.(string); ok && s != "" {
				email, _ := claims.Get("email")
				emailStr, _ := email.(string)
				return &Principal{Role: RoleUser, Name: s, Email: emailStr}, nil
			}
		}
	}
	return nil, fmt.Errorf("no usable name claim")
}

// verifyJWT fetches the JWK set for url, finds the key matching kid, verifies
// the signature and standard time claims plus the given extra validators.
func verifyJWT(ctx context.Context, cache *jwkCache, raw string, alg jwa.SignatureAlgorithm, kid, url string, extra ...jwt.ValidateOption) (jwt.Token, error) {
	if alg != jwa.RS256 && alg != jwa.ES256 {
		return nil, fmt.Errorf("unsupported alg %q", alg)
	}
	set, err := cache.get(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("fetch jwks: %w", err)
	}
	key, ok := set.LookupKeyID(kid)
	if !ok {
		return nil, fmt.Errorf("key %q not found", kid)
	}
	verified, err := jws.Verify([]byte(raw), jws.WithKey(alg, key))
	if err != nil {
		return nil, fmt.Errorf("verify signature: %w", err)
	}
	tok, err := jwt.Parse(verified, jwt.WithValidate(false))
	if err != nil {
		return nil, fmt.Errorf("parse claims: %w", err)
	}
	opts := extra // jwt.Validate checks exp/nbf automatically when present
	if err := jwt.Validate(tok, opts...); err != nil {
		return nil, fmt.Errorf("validate claims: %w", err)
	}
	return tok, nil
}
