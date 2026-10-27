USE realtime_chat;

-- Additive only: existing rows keep their IDs and values. Both columns stay NULL
-- for messages created by older versions of the application.
ALTER TABLE messages
  ADD COLUMN sender_user_id BIGINT UNSIGNED NULL AFTER sender,
  ADD COLUMN client_message_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER sender_user_id,
  ADD UNIQUE KEY uq_messages_sender_client_message (sender_user_id, client_message_id);
