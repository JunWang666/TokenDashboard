// Package migrations embeds the hub's SQLite schema migrations, copied from
// cloudflare-hub/migrations.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
