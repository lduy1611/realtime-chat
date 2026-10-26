'use strict';

const { createServer } = require('./server');
const { createPool, verifyDatabase } = require('./db');
const { MessageStore } = require('./messages');

const PORT = Number(process.env.PORT) || 3000;
const pool = createPool();

async function start() {
  try {
    await verifyDatabase(pool);
    const { httpServer } = createServer({ messageStore: new MessageStore(pool) });
    httpServer.listen(PORT, () => {
      console.log(`realtime-chat listening on http://localhost:${PORT}`);
    });
    const shutdown = () => httpServer.close(() => pool.end().finally(() => process.exit(0)));
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    console.error('Could not connect to MySQL. Check your .env settings and that MySQL is running.', error.message);
    await pool.end();
    process.exitCode = 1;
  }
}

start();
