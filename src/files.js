'use strict';

const path = require('path');

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.txt', '.docx']);

class FileStore {
  constructor(pool) { this.pool = pool; }

  async save(file) {
    const [result] = await this.pool.execute(
      'INSERT INTO files (room, uploaded_by, uploader_username, original_name, storage_name, mime_type, size_bytes, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [file.room, file.uploadedBy, file.uploader, file.originalName, file.storageName, file.mimeType, file.size, file.timestamp]
    );
    return { ...file, id: Number(result.insertId) };
  }

  async findById(id) {
    const [rows] = await this.pool.execute(
      'SELECT id, room, uploaded_by AS uploadedBy, uploader_username AS uploader, original_name AS originalName, storage_name AS storageName, mime_type AS mimeType, size_bytes AS size, created_at_ms AS timestamp FROM files WHERE id = ?',
      [id]
    );
    return rows[0] ? normalizeRow(rows[0]) : null;
  }

  async getRoomHistory(room, limit = 100) {
    const [rows] = await this.pool.execute(
      'SELECT id, room, uploaded_by AS uploadedBy, uploader_username AS uploader, original_name AS originalName, storage_name AS storageName, mime_type AS mimeType, size_bytes AS size, created_at_ms AS timestamp FROM files WHERE room = ? ORDER BY id DESC LIMIT ?',
      [room, limit]
    );
    return rows.reverse().map(normalizeRow).map(publicFile);
  }

  async getRoomFilesAfter(room, afterId) {
    const [rows] = await this.pool.execute(
      'SELECT id, room, uploaded_by AS uploadedBy, uploader_username AS uploader, original_name AS originalName, storage_name AS storageName, mime_type AS mimeType, size_bytes AS size, created_at_ms AS timestamp FROM files WHERE room = ? AND id > ? ORDER BY id ASC',
      [room, afterId]
    );
    return rows.map(normalizeRow).map(publicFile);
  }
}

function normalizeRow(row) {
  return { ...row, id: Number(row.id), uploadedBy: Number(row.uploadedBy), size: Number(row.size), timestamp: Number(row.timestamp) };
}

function publicFile(file) {
  return {
    id: file.id, type: 'file', room: file.room, from: file.uploader,
    fileName: file.originalName, fileSize: file.size, mimeType: file.mimeType,
    timestamp: file.timestamp, downloadUrl: `/api/files/${file.id}/download`
  };
}

function safeOriginalName(name) {
  return path.basename(String(name || '').replace(/[\\/]/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || 'upload';
}

function detectFile(buffer, originalName) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
  const ext = path.extname(originalName).toLowerCase();
  if (!ALLOWED.has(ext)) return null;
  const starts = (...bytes) => bytes.every((byte, i) => buffer[i] === byte);
  const mime = new Map([
    ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
    ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.pdf', 'application/pdf'],
    ['.txt', 'text/plain'], ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
  ]).get(ext);
  let valid = false;
  if (ext === '.png') valid = starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  else if (ext === '.jpg' || ext === '.jpeg') valid = starts(0xff, 0xd8, 0xff);
  else if (ext === '.gif') valid = buffer.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/) !== null;
  else if (ext === '.webp') valid = buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  else if (ext === '.pdf') valid = buffer.subarray(0, 1024).toString('latin1').includes('%PDF-');
  else if (ext === '.txt') {
    valid = !buffer.includes(0);
    if (valid) { try { new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch (_) { valid = false; } }
  } else if (ext === '.docx') {
    // Inspect ZIP central-directory entry names and require the OOXML document parts.
    const entries = new Set();
    for (let offset = 0; offset + 46 <= buffer.length; offset++) {
      if (buffer.readUInt32LE(offset) !== 0x02014b50) continue;
      const nameLength = buffer.readUInt16LE(offset + 28);
      const extraLength = buffer.readUInt16LE(offset + 30);
      const commentLength = buffer.readUInt16LE(offset + 32);
      if (offset + 46 + nameLength + extraLength + commentLength > buffer.length) break;
      entries.add(buffer.toString('utf8', offset + 46, offset + 46 + nameLength));
      offset += 45 + nameLength + extraLength + commentLength;
    }
    valid = starts(0x50, 0x4b, 0x03, 0x04) && entries.has('[Content_Types].xml') && entries.has('word/document.xml');
  }
  return valid ? { ext, mime } : null;
}

module.exports = { FileStore, MAX_FILE_SIZE, safeOriginalName, detectFile, publicFile };
