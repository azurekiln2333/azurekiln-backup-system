import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import * as oidc from 'openid-client';
import { AppError } from './config.mjs';

const sessionCookie = 'backup_session';
const transactionCookie = 'backup_oidc';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const credentials = z.object({ username: z.string().trim().min(1).max(100), password: z.string().min(12).max(1024), setupToken: z.string().max(1024).optional() });
const loginCredentials = credentials.extend({ password: z.string().min(1).max(1024) });

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyPassword(password, encoded) {
  const [algorithm, salt, hash] = encoded.split(':');
  if (algorithm !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function equalText(left, right) {
  return timingSafeEqual(Buffer.from(digest(left)), Buffer.from(digest(right)));
}

function cookie(req, name) {
  const value = String(req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return value ? value.slice(name.length + 1) : '';
}

export function createAuth({ store, config }) {
  const loginAttempts = new Map();
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: config.publicUrl.startsWith('https:'), path: '/api' };
  const loopbackHosts = ['localhost', '127.0.0.1', '::1', '[::1]'];
  const exposedSetup = () => !loopbackHosts.includes(config.host) || !loopbackHosts.includes(new URL(config.publicUrl).hostname);
  if (!store.getAdmin() && config.adminUsername && config.adminPassword) {
    const input = credentials.parse({ username: config.adminUsername, password: config.adminPassword });
    store.createAdmin(input.username, hashPassword(input.password));
  }
  function newSession(res) {
    const token = randomBytes(32).toString('hex');
    const csrf = randomBytes(32).toString('hex');
    const maxAge = 24 * 60 * 60 * 1000;
    store.saveSession(digest(token), csrf, Date.now() + maxAge);
    res.cookie(sessionCookie, token, { ...cookieOptions, maxAge });
    return { authenticated: true, user: { username: store.getAdmin().username }, csrfToken: csrf };
  }
  function identify(req, _res, next) {
    const token = cookie(req, sessionCookie);
    req.session = /^[\da-f]{64}$/.test(token) ? store.getSession(digest(token)) : null;
    req.sessionHash = req.session ? digest(token) : null;
    next();
  }
  function requireAuth(req, _res, next) {
    if (!req.session) return next(new AppError('Sign in to continue.', 401, 'UNAUTHENTICATED'));
    next();
  }
  function checkOrigin(req, _res, next) {
    const origin = req.headers.origin;
    if (origin && origin !== config.publicUrl) return next(new AppError('Request origin is not allowed.', 403, 'ORIGIN_FORBIDDEN'));
    next();
  }
  function csrf(req, _res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const supplied = req.headers['x-csrf-token'];
    if (!req.session || typeof supplied !== 'string' || !equalText(supplied, req.session.csrf)) return next(new AppError('Session verification failed. Refresh the page and try again.', 403, 'CSRF_INVALID'));
    next();
  }
  function status(req, res) {
    const initialized = Boolean(store.getAdmin());
    const settings = store.getSettings();
    res.json({ initialized, authenticated: Boolean(req.session), user: req.session ? { username: store.getAdmin().username } : null, csrfToken: req.session?.csrf || null, oidcEnabled: initialized && settings.oidc.enabled, setupTokenRequired: Boolean(config.setupToken) || exposedSetup() });
  }
  function setup(req, res) {
    if (store.getAdmin()) throw new AppError('The administrator has already been initialized.', 409, 'ALREADY_INITIALIZED');
    const input = credentials.parse(req.body);
    const peer = req.socket.remoteAddress;
    if (config.setupToken) {
      if (!input.setupToken || !equalText(input.setupToken, config.setupToken)) throw new AppError('The setup token is invalid.', 403, 'SETUP_TOKEN_INVALID');
    } else if (exposedSetup() || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) || req.headers['x-forwarded-for'] || req.headers.forwarded) {
      throw new AppError('Set SETUP_TOKEN or provision ADMIN_USERNAME and ADMIN_PASSWORD before initializing an exposed server.', 403, 'SETUP_REQUIRES_LOCAL');
    }
    store.createAdmin(input.username, hashPassword(input.password));
    res.status(201).json(newSession(res));
  }
  function login(req, res) {
    const input = loginCredentials.parse(req.body);
    const key = req.socket.remoteAddress;
    const now = Date.now();
    const attempt = loginAttempts.get(key);
    if (attempt?.expires > now && attempt.count >= 10) throw new AppError('Too many sign-in attempts. Try again later.', 429, 'LOGIN_RATE_LIMIT');
    const admin = store.getAdmin();
    const valid = admin && equalText(input.username, admin.username) && verifyPassword(input.password, admin.passwordHash);
    if (!valid) {
      if (loginAttempts.size > 10000) for (const [ip, item] of loginAttempts) if (item.expires <= now) loginAttempts.delete(ip);
      loginAttempts.set(key, { count: attempt?.expires > now ? attempt.count + 1 : 1, expires: attempt?.expires > now ? attempt.expires : now + 15 * 60 * 1000 });
      throw new AppError('The username or password is incorrect.', 401, 'LOGIN_FAILED');
    }
    loginAttempts.delete(key);
    if (req.sessionHash) store.deleteSession(req.sessionHash);
    res.json(newSession(res));
  }
  function logout(req, res) {
    store.deleteSession(req.sessionHash);
    res.clearCookie(sessionCookie, cookieOptions);
    res.status(204).end();
  }
  async function discover(settings) {
    const issuer = new URL(settings.issuer);
    const execute = [oidc.enableNonRepudiationChecks];
    if (issuer.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname)) execute.push(oidc.allowInsecureRequests);
    const options = { execute, timeout: 15 };
    return oidc.discovery(issuer, settings.clientId, settings.clientSecret, undefined, options);
  }
  async function start(req, res) {
    const settings = store.getSettings({ includeSecrets: true }).oidc;
    if (!store.getAdmin() || !settings.enabled) throw new AppError('OIDC sign-in is not enabled.', 400, 'OIDC_DISABLED');
    const client = await discover(settings);
    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const token = randomBytes(32).toString('hex');
    const redirectUri = `${config.publicUrl}/api/auth/oidc/callback`;
    store.saveOAuthTransaction(digest(token), { verifier, state, nonce, issuer: settings.issuer, subject: settings.subject, clientId: settings.clientId, redirectUri }, Date.now() + 10 * 60 * 1000);
    res.cookie(transactionCookie, token, { ...cookieOptions, maxAge: 10 * 60 * 1000 });
    const url = oidc.buildAuthorizationUrl(client, { redirect_uri: redirectUri, scope: 'openid profile', code_challenge: challenge, code_challenge_method: 'S256', state, nonce });
    res.redirect(url.href);
  }
  async function callback(req, res) {
    const token = cookie(req, transactionCookie);
    const transaction = /^[\da-f]{64}$/.test(token) ? store.consumeOAuthTransaction(digest(token)) : null;
    res.clearCookie(transactionCookie, cookieOptions);
    if (!transaction) throw new AppError('The authorization request expired or is invalid.', 401, 'OIDC_TRANSACTION_INVALID');
    const settings = store.getSettings({ includeSecrets: true }).oidc;
    if (!settings.enabled || settings.issuer !== transaction.issuer || settings.subject !== transaction.subject || settings.clientId !== transaction.clientId) throw new AppError('OIDC configuration changed during sign-in. Try again.', 401, 'OIDC_CONFIG_CHANGED');
    const client = await discover(settings);
    const url = new URL(req.originalUrl, config.publicUrl);
    let tokens;
    try {
      tokens = await oidc.authorizationCodeGrant(client, url, { pkceCodeVerifier: transaction.verifier, expectedState: transaction.state, expectedNonce: transaction.nonce, idTokenExpected: true });
    } catch { throw new AppError('The authorization response could not be verified.', 401, 'OIDC_RESPONSE_INVALID'); }
    const claims = tokens.claims();
    if (!claims || claims.iss !== settings.issuer || claims.sub !== settings.subject) throw new AppError('This OAuth identity is not bound to the administrator.', 403, 'OIDC_IDENTITY_FORBIDDEN');
    if (req.sessionHash) store.deleteSession(req.sessionHash);
    newSession(res);
    res.redirect('/');
  }
  return { identify, requireAuth, checkOrigin, csrf, status, setup, login, logout, start, callback };
}
