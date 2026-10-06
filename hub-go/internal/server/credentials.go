package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"tokendash/hub/internal/apperr"
	"tokendash/hub/internal/auth"
)

// externalRunnerProviders mirrors credentials.ts EXTERNAL_RUNNER_PROVIDERS:
// providers only the external (service-token) runner may see; the internal
// in-process runner gets everything else.
var externalRunnerProviders = map[string]bool{"kimi": true, "codex": true}

func (s *Server) registerCredentials(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/credentials", s.require(auth.RoleUser, auth.RoleClient)(http.HandlerFunc(s.handleCredentialsList)))
	mux.Handle("PUT /api/v1/credentials/{provider}", s.require(auth.RoleUser, auth.RoleClient)(http.HandlerFunc(s.handleCredentialPut)))
	mux.Handle("PATCH /api/v1/credentials/{provider}", s.require(auth.RoleUser, auth.RoleClient)(http.HandlerFunc(s.handleCredentialPatch)))
	mux.Handle("DELETE /api/v1/credentials/{provider}", s.require(auth.RoleUser)(http.HandlerFunc(s.handleCredentialDelete)))
	mux.Handle("GET /api/v1/internal/credentials", s.require(auth.RoleRunner)(http.HandlerFunc(s.handleInternalCredentials)))
}

// credentialName mirrors credentials.ts credentialName: explicit non-empty
// name (trimmed, ≤50 chars) or "默认".
func credentialName(name any) string {
	if s, ok := name.(string); ok && strings.TrimSpace(s) != "" {
		return trim50(strings.TrimSpace(s))
	}
	return "默认"
}

// updatedBy mirrors credentials.ts updatedBy: service-token clients are
// "client:<common_name>"; otherwise an x-client-device header wins; anything
// else is "web:<name>" (Access email, Logto username, dev token...).
func updatedBy(r *http.Request) string {
	p, _ := auth.PrincipalFrom(r.Context())
	if p.Role == auth.RoleClient {
		return "client:" + p.Name
	}
	if device := r.Header.Get("x-client-device"); device != "" {
		return "client:" + device
	}
	return "web:" + p.Name
}

// handleCredentialsList mirrors credentials.ts list (no plaintext).
func (s *Server) handleCredentialsList(w http.ResponseWriter, r *http.Request) {
	rows, err := s.Store.DB().QueryContext(r.Context(),
		`SELECT provider, name, hint, updated_at, updated_by FROM credentials ORDER BY provider, name`)
	if err != nil {
		s.Log.Error("credentials list failed", "err", err)
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}
	defer rows.Close()

	type credentialRow struct {
		Provider  string  `json:"provider"`
		Name      string  `json:"name"`
		Hint      *string `json:"hint"`
		UpdatedAt string  `json:"updated_at"`
		UpdatedBy *string `json:"updated_by"`
	}
	out := []credentialRow{}
	for rows.Next() {
		var cr credentialRow
		if err := rows.Scan(&cr.Provider, &cr.Name, &cr.Hint, &cr.UpdatedAt, &cr.UpdatedBy); err != nil {
			s.Log.Error("credentials scan failed", "err", err)
			apperr.Error(w, http.StatusInternalServerError, "internal")
			return
		}
		out = append(out, cr)
	}
	if err := rows.Err(); err != nil {
		s.Log.Error("credentials iterate failed", "err", err)
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}
	apperr.WriteJSON(w, http.StatusOK, map[string]any{"rows": out})
}

// handleCredentialPut mirrors credentials.ts put: normalize the payload to a
// JSON object (bare strings become {"value": ...}), encrypt, upsert.
func (s *Server) handleCredentialPut(w http.ResponseWriter, r *http.Request) {
	provider := r.PathValue("provider")
	if !providerSet[provider] {
		badf(w, "unknown provider: %s", provider)
		return
	}
	body, _ := decodeBody(r)
	if body == nil {
		bad(w, "invalid json body")
		return
	}
	payload, ok := body["payload"]
	if !ok || payload == nil {
		bad(w, "payload required (object or string)")
		return
	}
	name := credentialName(body["name"])

	// 统一存成 JSON 对象，runner 侧拿到的一定是可解析的 Record<string,string>
	var plaintext []byte
	if str, isStr := payload.(string); isStr {
		plaintext, _ = json.Marshal(map[string]any{"value": str})
	} else {
		plaintext, _ = json.Marshal(payload)
	}
	payloadEnc, err := s.Crypt.Encrypt(plaintext)
	if err != nil {
		s.Log.Error("credential encrypt failed", "err", err)
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}
	hint := credentialHintValue(payload)
	updater := updatedBy(r)

	_, err = s.Store.DB().ExecContext(r.Context(),
		`INSERT INTO credentials (provider, name, payload_enc, hint, updated_at, updated_by)
		 VALUES (?,?,?,?, datetime('now'), ?)
		 ON CONFLICT (provider, name) DO UPDATE SET
		   payload_enc = excluded.payload_enc,
		   hint = excluded.hint,
		   updated_at = datetime('now'),
		   updated_by = excluded.updated_by`,
		provider, name, payloadEnc, hint, updater,
	)
	if err != nil {
		s.Log.Error("credential upsert failed", "err", err)
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}
	apperr.WriteJSON(w, http.StatusOK, map[string]any{
		"ok": true, "provider": provider, "name": name, "hint": hint, "updated_by": updater,
	})
}

// handleCredentialPatch mirrors credentials.ts patch: merge the submitted
// fields into the decrypted existing payload, re-encrypt, and use the old
// ciphertext as an optimistic lock (up to 3 attempts, then 409).
func (s *Server) handleCredentialPatch(w http.ResponseWriter, r *http.Request) {
	provider := r.PathValue("provider")
	if !providerSet[provider] {
		badf(w, "unknown provider: %s", provider)
		return
	}
	body, _ := decodeBody(r)
	if body == nil {
		bad(w, "invalid json body")
		return
	}
	changes, ok := body["payload"].(map[string]any)
	if !ok || len(changes) == 0 {
		bad(w, "payload required (non-empty object)")
		return
	}
	name := credentialName(body["name"])
	updater := updatedBy(r)

	for attempt := 0; attempt < 3; attempt++ {
		var payloadEnc string
		err := s.Store.DB().QueryRowContext(r.Context(),
			`SELECT payload_enc FROM credentials WHERE provider = ? AND name = ?`,
			provider, name).Scan(&payloadEnc)
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "credential not found: "+provider+"/"+name)
			return
		}
		if err != nil {
			s.Log.Error("credential read failed", "err", err)
			apperr.Error(w, http.StatusInternalServerError, "internal")
			return
		}

		plain, err := s.Crypt.Decrypt(payloadEnc)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "credential_unreadable", "stored credential cannot be decrypted")
			return
		}
		var parsed any
		if err := json.Unmarshal(plain, &parsed); err != nil {
			// TS folds JSON.parse failures into the same unreadable error.
			writeErr(w, http.StatusInternalServerError, "credential_unreadable", "stored credential cannot be decrypted")
			return
		}
		current, ok := parsed.(map[string]any)
		if !ok {
			writeErr(w, http.StatusInternalServerError, "credential_unreadable", "stored credential is not an object")
			return
		}

		// 提交的字段覆盖旧字段，其余保持不变。
		for k, v := range changes {
			current[k] = v
		}
		mergedPlain, _ := json.Marshal(current)
		newEnc, err := s.Crypt.Encrypt(mergedPlain)
		if err != nil {
			s.Log.Error("credential encrypt failed", "err", err)
			apperr.Error(w, http.StatusInternalServerError, "internal")
			return
		}
		hint := credentialHintValue(current)

		res, err := s.Store.DB().ExecContext(r.Context(),
			`UPDATE credentials
			 SET payload_enc = ?, hint = ?, updated_at = datetime('now'), updated_by = ?
			 WHERE provider = ? AND name = ? AND payload_enc = ?`,
			newEnc, hint, updater, provider, name, payloadEnc,
		)
		if err != nil {
			s.Log.Error("credential update failed", "err", err)
			apperr.Error(w, http.StatusInternalServerError, "internal")
			return
		}
		if n, _ := res.RowsAffected(); n == 1 {
			apperr.WriteJSON(w, http.StatusOK, map[string]any{
				"ok": true, "provider": provider, "name": name, "hint": hint, "updated_by": updater,
			})
			return
		}
	}

	writeErr(w, http.StatusConflict, "conflict", "credential changed concurrently; retry the request")
}

// handleCredentialDelete mirrors credentials.ts del: without ?name= the whole
// provider is deleted, along with the matching quota snapshots/current rows,
// all in one transaction.
func (s *Server) handleCredentialDelete(w http.ResponseWriter, r *http.Request) {
	provider := r.PathValue("provider")
	if !providerSet[provider] {
		badf(w, "unknown provider: %s", provider)
		return
	}
	name := r.URL.Query().Get("name")

	db := s.Store.DB()
	tx, err := db.BeginTx(r.Context(), nil)
	if err != nil {
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}
	defer tx.Rollback()

	var res int64
	if name != "" {
		resRow, err := tx.ExecContext(r.Context(),
			`DELETE FROM credentials WHERE provider = ? AND name = ?`, provider, name)
		if err != nil {
			apperr.Error(w, http.StatusInternalServerError, "internal")
			return
		}
		if _, err := tx.ExecContext(r.Context(),
			`DELETE FROM quota_snapshots WHERE provider = ? AND account = ?`, provider, name); err != nil {
			apperr.Error(w, http.StatusInternalServerError, "internal")
			return
		}
		if _, err := tx.ExecContext(r.Context(),
			`DELETE FROM quota_current WHERE provider = ? AND account = ?`, provider, name); err != nil {
			apperr.Error(w, http.StatusInternalServerError, "internal")
			return
		}
		res, _ = resRow.RowsAffected()
	} else {
		resRow, err := tx.ExecContext(r.Context(),
			`DELETE FROM credentials WHERE provider = ?`, provider)
		if err != nil {
			apperr.Error(w, http.StatusInternalServerError, "internal")
			return
		}
		if _, err := tx.ExecContext(r.Context(),
			`DELETE FROM quota_snapshots WHERE provider = ?`, provider); err != nil {
			apperr.Error(w, http.StatusInternalServerError, "internal")
			return
		}
		if _, err := tx.ExecContext(r.Context(),
			`DELETE FROM quota_current WHERE provider = ?`, provider); err != nil {
			apperr.Error(w, http.StatusInternalServerError, "internal")
			return
		}
		res, _ = resRow.RowsAffected()
	}

	if err := tx.Commit(); err != nil {
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}
	apperr.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": res})
}

// internalCredEntry is one decrypted credential destined for runners, shared
// by handleInternalCredentials (which serializes it) and the built-in
// collector (which runs adapters against it).
type internalCredEntry struct {
	provider string
	name     string
	fields   map[string]any // decrypted payload object; nil when errMsg != ""
	errMsg   string         // non-empty when the payload could not be decrypted
}

// flatten renders the decrypted payload as the Record<string,string> adapters
// expect: string values pass through, anything else keeps its JSON text
// (e.g. an object-valued "cookies" field, see the anyrouter_top adapter).
func (e *internalCredEntry) flatten() map[string]string {
	flat := make(map[string]string, len(e.fields))
	for k, v := range e.fields {
		if sv, ok := v.(string); ok {
			flat[k] = sv
		} else if b, err := json.Marshal(v); err == nil {
			flat[k] = string(b)
		}
	}
	return flat
}

// decryptCredentials reads all credentials visible to the given runner kind:
// external runners (principal other than internal-runner) only get
// EXTERNAL_RUNNER_PROVIDERS; the built-in in-process runner gets everything
// else. Undecryptable entries are returned with errMsg set instead of being
// dropped, mirroring credentials.ts internalList.
func (s *Server) decryptCredentials(ctx context.Context, external bool) ([]internalCredEntry, error) {
	rows, err := s.Store.DB().QueryContext(ctx,
		`SELECT provider, name, payload_enc FROM credentials ORDER BY provider, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type cred struct {
		provider   string
		name       string
		payloadEnc string
	}
	var creds []cred
	for rows.Next() {
		var c cred
		if err := rows.Scan(&c.provider, &c.name, &c.payloadEnc); err != nil {
			return nil, err
		}
		creds = append(creds, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	var out []internalCredEntry
	for _, c := range creds {
		if external != externalRunnerProviders[c.provider] {
			continue
		}
		plain, err := s.Crypt.Decrypt(c.payloadEnc)
		if err != nil {
			out = append(out, internalCredEntry{provider: c.provider, name: c.name,
				errMsg: "decrypt failed: " + err.Error()})
			continue
		}
		var fields map[string]any
		if err := json.Unmarshal(plain, &fields); err != nil {
			// TS folds JSON.parse failures into the same unreadable error.
			out = append(out, internalCredEntry{provider: c.provider, name: c.name,
				errMsg: "decrypt failed: " + err.Error()})
			continue
		}
		// TS spreads { name, ...JSON.parse(plain) }: a stored "name" field wins.
		name := c.name
		if n, ok := fields["name"].(string); ok && n != "" {
			name = n
		}
		out = append(out, internalCredEntry{provider: c.provider, name: name, fields: fields})
	}
	return out, nil
}

// handleInternalCredentials mirrors credentials.ts internalList: decrypt all
// credentials for runners. External runners (any principal other than
// internal-runner) only get EXTERNAL_RUNNER_PROVIDERS; the internal runner
// gets the rest. Undecryptable entries surface as {"name","__error__"}.
func (s *Server) handleInternalCredentials(w http.ResponseWriter, r *http.Request) {
	p, _ := auth.PrincipalFrom(r.Context())
	external := p.Name != "internal-runner"

	entries, err := s.decryptCredentials(r.Context(), external)
	if err != nil {
		s.Log.Error("internal credentials query failed", "err", err)
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}

	out := map[string][]map[string]any{}
	for _, e := range entries {
		entry := map[string]any{"name": e.name}
		if e.errMsg != "" {
			entry["__error__"] = e.errMsg
		} else {
			for k, v := range e.fields {
				entry[k] = v
			}
		}
		out[e.provider] = append(out[e.provider], entry)
	}
	apperr.WriteJSON(w, http.StatusOK, out)
}
