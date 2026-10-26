'use strict';

const NAME_RE = /^[A-Za-z0-9_-]{2,20}$/;

const LIMITS = {
  NAME_MIN: 2,
  NAME_MAX: 20,
  MESSAGE_MAX: 500
};

function validateName(value, label) {
  if (typeof value !== 'string') return `${label} is required`;
  const trimmed = value.trim();
  if (!NAME_RE.test(trimmed)) {
    return `${label} must be ${LIMITS.NAME_MIN}-${LIMITS.NAME_MAX} characters (letters, numbers, _ or -)`;
  }
  return null;
}

module.exports = { LIMITS, validateName };

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/** Returns { error } or { text } with trimmed, escaped, length-checked content. */
function sanitizeMessage(value) {
  if (typeof value !== 'string') return { error: 'Message must be text' };
  const trimmed = value.trim();
  if (!trimmed) return { error: 'Message cannot be empty' };
  if (trimmed.length > LIMITS.MESSAGE_MAX) {
    return { error: `Message exceeds ${LIMITS.MESSAGE_MAX} characters` };
  }
  return { text: escapeHtml(trimmed) };
}

module.exports.escapeHtml = escapeHtml;
module.exports.sanitizeMessage = sanitizeMessage;
