// Package apperr provides uniform JSON response helpers.
package apperr

import (
	"encoding/json"
	"fmt"
	"net/http"
)

// WriteJSON writes v as a JSON response with the given status code.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// Error writes a JSON error response of the form {"error": msg}.
func Error(w http.ResponseWriter, status int, msg string) {
	WriteJSON(w, status, map[string]string{"error": msg})
}

// Errorf is Error with a formatted message.
func Errorf(w http.ResponseWriter, status int, format string, args ...any) {
	Error(w, status, fmt.Sprintf(format, args...))
}
