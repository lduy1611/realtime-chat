'use strict';

require('dotenv').config();
const mysql = require('mysql2/promise');

function createPool(env = process.env) {
  return mysql.createPool({
    host: env.DB_HOST || 'localhost',
    port: Number(env.DB_PORT) || 3306,
    user: env.DB_USER || 'root',
    password: env.DB_PASSWORD || '',
    database: env.DB_NAME || 'realtime_chat',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4'
  });
}

async function verifyDatabase(pool) {
  const connection = await pool.getConnection();
  connection.release();
}

module.exports = { createPool, verifyDatabase };
