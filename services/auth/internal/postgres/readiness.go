package postgres

import (
	"context"
	"errors"
)

// CheckReady uses the service connection role. The zero-row SELECT checks the
// required tables, columns and read access without fetching credential data.
// Write privileges are checked individually: a comma-separated privilege list
// in has_table_privilege would accept ANY listed privilege, not all of them.
func (r *Repository) CheckReady(ctx context.Context) error {
	_, err := r.db.ExecContext(ctx, `SELECT
  u.id, u.username, u.username_normalized, u.password_hash, u.created_at,
  rt.id, rt.user_id, rt.token_hash, rt.expires_at, rt.revoked_at
 FROM auth.users AS u CROSS JOIN auth.refresh_tokens AS rt LIMIT 0`)
	if err != nil {
		return errors.New("auth schema is not accessible")
	}
	var allowed bool
	err = r.db.QueryRowContext(ctx, `SELECT
  has_table_privilege(current_user, 'auth.users', 'INSERT') AND
  has_table_privilege(current_user, 'auth.refresh_tokens', 'INSERT') AND
  has_table_privilege(current_user, 'auth.refresh_tokens', 'UPDATE')`).Scan(&allowed)
	if err != nil || !allowed {
		return errors.New("auth write privileges are not available")
	}
	return nil
}
