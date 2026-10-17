CREATE INDEX notifications_unread_recipient_idx
  ON notifications(recipient_id, created_at DESC, id DESC) WHERE read_at IS NULL;
