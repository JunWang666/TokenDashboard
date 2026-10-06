package push

import (
	"context"
	"database/sql"
)

// deliveryRow mirrors push.ts DeliveryRow: a due delivery joined with its
// subscription and alert event content.
type deliveryRow struct {
	DeliveryID int64
	EventID    int64
	Attempts   int
	Title      string
	Body       string
	Subscription
}

// loadDueDeliveries mirrors the dispatchPendingPushes SELECT: active
// subscriptions with due pending/retry rows, or 'sending' rows stuck for over
// ten minutes (crashed between claim and completion).
func loadDueDeliveries(ctx context.Context, db *sql.DB) ([]deliveryRow, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT d.id, d.event_id, d.attempts, e.title, e.body,
		        s.id, s.platform, s.endpoint, s.keys_json, s.environment, s.active
		   FROM push_deliveries d
		   JOIN push_subscriptions s ON s.id = d.subscription_id
		   JOIN alert_events e ON e.id = d.event_id
		  WHERE s.active = 1 AND (
		          (d.status IN ('pending', 'retry') AND d.next_attempt_at <= datetime('now')) OR
		          (d.status = 'sending' AND d.last_attempt_at <= datetime('now', '-10 minutes'))
		        )
		  ORDER BY d.next_attempt_at, d.id
		  LIMIT 100`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []deliveryRow
	for rows.Next() {
		var d deliveryRow
		var keysJSON, environment sql.NullString
		var active int
		if err := rows.Scan(&d.DeliveryID, &d.EventID, &d.Attempts, &d.Title, &d.Body,
			&d.Subscription.ID, &d.Subscription.Platform, &d.Subscription.Endpoint,
			&keysJSON, &environment, &active); err != nil {
			return nil, err
		}
		if keysJSON.Valid {
			d.Subscription.KeysJSON = &keysJSON.String
		}
		d.Subscription.Environment = environment.String
		d.Subscription.Active = active == 1
		out = append(out, d)
	}
	return out, rows.Err()
}

// claimDelivery claims a delivery row before sending; a second overlapping
// worker sees zero affected rows and cannot double-send (push.ts processDelivery).
func claimDelivery(ctx context.Context, db *sql.DB, deliveryID int64) (bool, error) {
	res, err := db.ExecContext(ctx,
		`UPDATE push_deliveries
		    SET status = 'sending', attempts = attempts + 1,
		        last_attempt_at = datetime('now'), updated_at = datetime('now')
		  WHERE id = ? AND (
		          (status IN ('pending', 'retry') AND next_attempt_at <= datetime('now')) OR
		          (status = 'sending' AND last_attempt_at <= datetime('now', '-10 minutes'))
		        )`, deliveryID)
	if err != nil {
		return false, err
	}
	affected, err := res.RowsAffected()
	return affected > 0, err
}

// processDelivery claims, sends and completes one delivery row.
func (s *Sender) processDelivery(ctx context.Context, db *sql.DB, d deliveryRow) (string, error) {
	claimed, err := claimDelivery(ctx, db, d.DeliveryID)
	if err != nil {
		return "failed", err
	}
	if !claimed {
		return "skipped", nil
	}

	result := s.sendToSubscription(ctx, d.Subscription, Payload{Title: d.Title, Body: d.Body})
	if err := recordSubscriptionResult(ctx, db, d.Subscription, result); err != nil && s.log != nil {
		s.log.Error("record subscription result failed", "subscription_id", d.Subscription.ID, "err", err)
	}
	finalStatus, err := completeDelivery(ctx, db, d.DeliveryID, int(d.Attempts)+1, result)
	if err != nil {
		return "failed", err
	}
	logDelivery(s.log, d.DeliveryID, d.EventID, d.Subscription.ID, d.Platform, d.Environment,
		int(d.Attempts)+1, finalStatus, result)
	return finalStatus, nil
}

// DispatchPending sends all due deliveries, including retries left behind by
// an earlier sweep (push.ts dispatchPendingPushes). Delivery order is
// sequential; a crashing send is re-claimed by the stale-'sending' branch.
func (s *Sender) DispatchPending(ctx context.Context, db *sql.DB) (DispatchSummary, error) {
	due, err := loadDueDeliveries(ctx, db)
	if err != nil {
		return DispatchSummary{}, err
	}
	var summary DispatchSummary
	for _, d := range due {
		status, err := s.processDelivery(ctx, db, d)
		if err != nil && s.log != nil {
			s.log.Error("push delivery internal error", "delivery_id", d.DeliveryID,
				"subscription_id", d.Subscription.ID, "platform", d.Platform, "err", err)
			status = "failed"
		}
		switch status {
		case "sent":
			summary.Sent++
			summary.Processed++
		case "retry":
			summary.Retrying++
			summary.Processed++
		case "failed":
			summary.Failed++
			summary.Processed++
		}
	}
	return summary, nil
}
