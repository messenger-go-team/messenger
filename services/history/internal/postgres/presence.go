package postgres

import "context"

// ListPresencePeers takes one SQL snapshot of current two-person memberships.
func (r *Repository) ListPresencePeers(ctx context.Context, requesterID string) ([]string, error) {
	rows, err := r.DB.QueryContext(ctx, `
		SELECT DISTINCT peer.user_id
		FROM history.chat_members AS viewer
		JOIN history.chats AS chat ON chat.id = viewer.chat_id AND chat.type = 'personal'
		JOIN history.chat_members AS peer ON peer.chat_id = chat.id AND peer.user_id <> viewer.user_id
		WHERE viewer.user_id = $1
		  AND NOT EXISTS (
		      SELECT 1 FROM history.chat_members AS third
		      WHERE third.chat_id = chat.id AND third.user_id NOT IN (viewer.user_id, peer.user_id)
		  )
		ORDER BY peer.user_id`, requesterID)
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
