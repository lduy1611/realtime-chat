CREATE DATABASE IF NOT EXISTS realtime_chat
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE realtime_chat;

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  type ENUM('chat', 'private') NOT NULL,
  room VARCHAR(20) NOT NULL,
  sender VARCHAR(20) NOT NULL,
  recipient VARCHAR(20) NULL,
  text TEXT NOT NULL,
  created_at_ms BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  INDEX idx_messages_room_history (room, type, id),
  INDEX idx_messages_private_history (type, sender, recipient, id)
) ENGINE=InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
