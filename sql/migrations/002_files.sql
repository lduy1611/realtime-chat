USE realtime_chat;

-- Additive file metadata table. Existing users, sessions, and messages are untouched.
CREATE TABLE IF NOT EXISTS files (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  room VARCHAR(20) NOT NULL,
  uploaded_by BIGINT UNSIGNED NOT NULL,
  uploader_username VARCHAR(20) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  storage_name CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  size_bytes INT UNSIGNED NOT NULL,
  created_at_ms BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_files_storage_name (storage_name),
  KEY idx_files_room_id (room, id),
  CONSTRAINT fk_files_uploaded_by FOREIGN KEY (uploaded_by) REFERENCES users(id)
) ENGINE=InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
