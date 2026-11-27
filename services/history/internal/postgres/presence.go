package postgres

import (
	"context"
	"database/sql"
)

const presencePairs = `
	SELECT peer.user_id AS peer_id, chat.id AS chat_id
	FROM history.chat_members AS viewer
	JOIN history.chats AS chat ON chat.id = viewer.chat_id AND chat.type = 'personal'
	JOIN history.chat_members AS peer ON peer.chat_id = chat.id AND peer.user_id <> viewer.user_id
	WHERE viewer.user_id = $1
	  AND NOT EXISTS (
	      SELECT 1 FROM history.chat_members AS third
	      WHERE third.chat_id = chat.id AND third.user_id NOT IN (viewer.user_id, peer.user_id)
	  )`

func (r *Repository) ListPresencePeers(ctx context.Context, requesterID string) ([]string, error) {
	return queryPresenceIDs(ctx, r.DB, `
		SELECT DISTINCT peer_id FROM (`+presencePairs+`) AS pairs ORDER BY peer_id`, requesterID)
}

// AuthorizePresenceDelivery commits a reservation before returning a permit.
// The revoke triggers wait for it even if History or Chat stop unexpectedly.
func (r *Repository) AuthorizePresenceDelivery(ctx context.Context, requesterID string, peerIDs []string) ([]string, string, error) {
	tx, err := r.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback() }()

	chatIDs, err := queryPresenceIDs(ctx, tx, `
		SELECT chat_id FROM (
		    SELECT DISTINCT ON (peer_id) peer_id, chat_id
		    FROM (`+presencePairs+`) AS pairs
		    WHERE peer_id = ANY($2::uuid[])
		    ORDER BY peer_id, chat_id
		) AS candidates`, requesterID, peerIDs)
	if err != nil || len(chatIDs) == 0 {
		return nil, "", err
	}
	lockedChats, err := queryPresenceIDs(ctx, tx, `SELECT unnest(history.lock_presence_delivery($1::uuid[]))`, chatIDs)
	if err != nil || len(lockedChats) == 0 {
		return nil, "", err
	}
	// A separate READ COMMITTED statement sees changes since the first lookup.
	allowed, err := queryPresenceIDs(ctx, tx, `
		SELECT DISTINCT peer_id FROM (`+presencePairs+`) AS pairs
		WHERE peer_id = ANY($2::uuid[]) AND chat_id = ANY($3::uuid[])
		ORDER BY peer_id`, requesterID, peerIDs, lockedChats)
	if err != nil || len(allowed) == 0 {
		return nil, "", err
	}
	var grantID string
	err = tx.QueryRowContext(ctx, `
		WITH token AS MATERIALIZED (SELECT gen_random_uuid() AS id),
		     inserted AS (
		         INSERT INTO history.presence_deliveries (chat_id, grant_id)
		         SELECT DISTINCT chat.id, token.id FROM unnest($1::uuid[]) AS chat(id) CROSS JOIN token
		         RETURNING grant_id
		     )
		SELECT grant_id FROM inserted LIMIT 1`, lockedChats).Scan(&grantID)
	if err != nil {
		return nil, "", err
	}
	if err := tx.Commit(); err != nil {
		return nil, "", err
	}
	return allowed, grantID, nil
}

func (r *Repository) ReleasePresenceDeliveries(ctx context.Context, ids []string) error {
	_, err := r.DB.ExecContext(ctx, `DELETE FROM history.presence_deliveries WHERE grant_id = ANY($1::uuid[])`, ids)
	return err
}

func (r *Repository) ActivePresenceGrants(ctx context.Context) ([]string, error) {
	return queryPresenceIDs(ctx, r.DB, `SELECT DISTINCT grant_id FROM history.presence_deliveries`)
}

type presenceQuerier interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func queryPresenceIDs(ctx context.Context, db presenceQuerier, query string, args ...any) ([]string, error) {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
