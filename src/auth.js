'use strict';

const session = require('express-session');
const MySQLStoreFactory = require('express-mysql-session');
const bcrypt = require('bcryptjs');
const { validateName } = require('./validate');
const { RateLimiter } = require('./rateLimit');

const SESSION_COOKIE = 'realtime-chat.sid';
const SESSION_MAX_AGE = 8 * 60 * 60 * 1000;
const BCRYPT_ROUNDS = 12;

function createSession({ store, secret = process.env.SESSION_SECRET, nodeEnv = process.env.NODE_ENV, secureCookies, env = process.env } = {}) {
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET must be set to a random value with at least 32 characters');
  }

  const sessionStore = store || new (MySQLStoreFactory(session))({
    host: env.DB_HOST || 'localhost',
    port: Number(env.DB_PORT) || 3306,
    user: env.DB_USER || 'root',
    password: env.DB_PASSWORD || '',
    database: env.DB_NAME || 'realtime_chat',
    waitForConnections: true,
    connectionLimit: 5,
    createDatabaseTable: false,
    endConnectionOnClose: true,
    clearExpired: true,
    checkExpirationInterval: 15 * 60 * 1000,
    expiration: SESSION_MAX_AGE,
    charset: 'utf8mb4_bin'
  });

  const sessionMiddleware = session({
    name: SESSION_COOKIE,
    secret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies ?? (nodeEnv === 'production' ? true : 'auto'),
      maxAge: SESSION_MAX_AGE,
      path: '/'
    }
  });

  return { sessionStore, sessionMiddleware };
}

function promiseSessionAction(sessionObject, action) {
  return new Promise((resolve, reject) => sessionObject[action]((error) => error ? reject(error) : resolve()));
}

function sameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) return res.status(403).json({ error: 'Request origin is required' });
  try {
    const parsed = new URL(origin);
    if (parsed.origin === 'null' || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
      return res.status(403).json({ error: 'Invalid request origin' });
    }
    const trustProxy = req.app?.get('trust proxy fn');
    const remoteAddress = req.socket?.remoteAddress || req.connection?.remoteAddress;
    const canTrustForwardedHost = typeof trustProxy === 'function' && remoteAddress && trustProxy(remoteAddress, 0);
    const forwardedHost = canTrustForwardedHost ? req.get('x-forwarded-host') : null;
    const requestHost = (forwardedHost || req.get('host') || '').split(',')[0].trim();
    const requestOrigin = new URL(`${req.protocol}://${requestHost}`).origin;
    if (parsed.origin !== requestOrigin) {
      return res.status(403).json({ error: 'Cross-origin request denied' });
    }
  } catch (_) {
    return res.status(403).json({ error: 'Invalid request origin' });
  }
  next();
}

function createAuthRateLimit() {
  const clients = new Map();
  const limit = 10;
  const windowMs = 15 * 60 * 1000;

  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    let limiter = clients.get(key);
    if (!limiter) {
      limiter = new RateLimiter({ limit, windowMs });
      clients.set(key, limiter);
    }
    if (!limiter.allow()) return res.status(429).json({ error: 'Too many authentication attempts. Try again later.' });
    next();
  };
}

function installAuthRoutes(app, { userStore, io }) {
  const authRateLimit = createAuthRateLimit();
  const regenerateSession = async (req, user) => {
    await promiseSessionAction(req.session, 'regenerate');
    req.session.user = { id: user.id, username: user.username };
    await promiseSessionAction(req.session, 'save');
  };

  app.get('/api/auth/me', (req, res) => {
    if (!req.session.user) return res.status(401).json({ authenticated: false });
    res.json({ authenticated: true, user: req.session.user });
  });

  app.post('/api/auth/register', sameOrigin, authRateLimit, async (req, res) => {
    const { username, password } = req.body || {};
    const usernameError = validateName(username, 'Username');
    if (usernameError) return res.status(400).json({ error: usernameError });
    if (typeof password !== 'string' || password.length < 8 || bcrypt.truncates(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters and no more than 72 UTF-8 bytes' });
    }

    try {
      const normalizedUsername = username.trim();
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const user = await userStore.create(normalizedUsername, passwordHash);
      await regenerateSession(req, user);
      res.status(201).json({ authenticated: true, user });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Username is already registered' });
      console.error('Registration failed:', error);
      res.status(500).json({ error: 'Could not complete registration' });
    }
  });

  app.post('/api/auth/login', sameOrigin, authRateLimit, async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    try {
      const user = await userStore.findByUsername(username.trim());
      const matches = user && !bcrypt.truncates(password) && await bcrypt.compare(password, user.passwordHash);
      if (!matches) return res.status(401).json({ error: 'Invalid username or password' });
      await regenerateSession(req, user);
      res.json({ authenticated: true, user: { id: user.id, username: user.username } });
    } catch (error) {
      console.error('Login failed:', error);
      res.status(500).json({ error: 'Could not complete login' });
    }
  });

  app.post('/api/auth/logout', sameOrigin, async (req, res) => {
    const sessionId = req.sessionID;
    if (req.session) {
      try {
        await promiseSessionAction(req.session, 'destroy');
      } catch (error) {
        console.error('Logout failed:', error);
        return res.status(500).json({ error: 'Could not complete logout' });
      }
    }
    if (sessionId) io.in(`session:${sessionId}`).disconnectSockets(true);
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: req.secure || req.app.get('env') === 'production', path: '/' });
    res.json({ ok: true });
  });
}

module.exports = { SESSION_COOKIE, createSession, installAuthRoutes, sameOrigin };
