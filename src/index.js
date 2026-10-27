'use strict';

const { createServer } = require('./server');
const { createPool, verifyDatabase } = require('./db');
const { MessageStore } = require('./messages');
const { FileStore } = require('./files');
const { UserStore } = require('./users');
const { createSession } = require('./auth');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const pool = createPool();

async function start() {
  try {
    await verifyDatabase(pool);
    // Read-only checks: the user must apply the migration manually in Workbench.
    await pool.execute('SELECT id FROM users LIMIT 0');
    await pool.execute('SELECT session_id FROM sessions LIMIT 0');
    await pool.execute('SELECT id FROM files LIMIT 0');
    await pool.execute('SELECT client_message_id FROM messages LIMIT 0');
    const keyFile = process.env.HTTPS_KEY_FILE;
    const certFile = process.env.HTTPS_CERT_FILE;
    if (Boolean(keyFile) !== Boolean(certFile)) {
      throw new Error('Set both HTTPS_KEY_FILE and HTTPS_CERT_FILE to enable HTTPS');
    }
    const httpsOptions = keyFile && certFile ? {
      key: fs.readFileSync(path.resolve(keyFile)),
      cert: fs.readFileSync(path.resolve(certFile))
    } : null;
    const { sessionStore, sessionMiddleware } = createSession({ secureCookies: httpsOptions ? true : undefined });
    if (typeof sessionStore.onReady === 'function') await sessionStore.onReady();
    const { httpServer } = createServer({
      messageStore: new MessageStore(pool),
      fileStore: new FileStore(pool),
      uploadsDir: process.env.UPLOADS_DIR,
      userStore: new UserStore(pool),
      sessionMiddleware,
      httpsOptions
    });
    httpServer.listen(PORT, () => {
      const protocol = httpsOptions ? 'https' : 'http';
      console.log(`realtime-chat listening on ${protocol}://localhost:${PORT}`);
    });
    const shutdown = () => httpServer.close(async () => {
      await sessionStore.close?.();
      await pool.end();
      process.exit(0);
    });
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    console.error('Could not initialize MySQL/auth/files. Check .env and apply the reviewed SQL migrations in Workbench.', error.message);
    await pool.end();
    process.exitCode = 1;
  }
}

start();
