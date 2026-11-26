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

// AuthorizePresenceDelivery orders a fresh membership read against revocation.
// Migration 4 enforces a grace period on the mutation side even if this
// process, connection or response disappears after committing a grant.
func (r *Repository) AuthorizePresenceDelivery(ctx context.Context, requesterID string, peerIDs []string) ([]string, error) {
	tx, err := r.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted, ReadOnly: true})
	if err != nil {
		return nil, err
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
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `SELECT history.lock_presence_delivery($1::uuid[])`, chatIDs); err != nil {
		return nil, err
	}
	// A separate statement at READ COMMITTED sees revocations that committed
	// while the shared locks were being obtained.
	allowed, err := queryPresenceIDs(ctx, tx, `
		SELECT DISTINCT peer_id FROM (`+presencePairs+`) AS pairs
		WHERE peer_id = ANY($2::uuid[]) AND chat_id = ANY($3::uuid[])
		ORDER BY peer_id`, requesterID, peerIDs, chatIDs)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return allowed, nil
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
