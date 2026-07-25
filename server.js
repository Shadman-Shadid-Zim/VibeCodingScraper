require('dotenv').config();
const express        = require('express');
const session        = require('express-session');
const passport       = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const LocalStrategy  = require('passport-local').Strategy;
const Database       = require('better-sqlite3');
const bcrypt         = require('bcryptjs');
const jwt            = require('jsonwebtoken');
const nodemailer     = require('nodemailer');
const puppeteer      = require('puppeteer-extra');
const StealthPlugin  = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { v4: uuidv4 } = require('uuid');
const path           = require('path');
const cors           = require('cors');
const crypto         = require('crypto');

// ─── SITE-CREDENTIAL ENCRYPTION ───────────────────────────────────────────────
// Passwords the platform stores on behalf of end-users (so a marketplace API can log in as
// THEM, not the API's creator) are encrypted at rest with AES-256-GCM. Never store or log
// these in plaintext outside this module.
const CRED_KEY = crypto.createHash('sha256').update(process.env.CRED_ENC_KEY || 'dev-only-insecure-key-set-CRED_ENC_KEY-in-.env').digest();
function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', CRED_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}
function decryptSecret(blob) {
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', CRED_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// Recorded session cookies are full login credentials in every practical sense (some are the
// exact token that proves an authenticated session — no password needed) so they're encrypted at
// rest the same way as saved site logins. encryptCookies/decryptCookiesField also transparently
// read plain, unencrypted JSON from rows written before this existed.
function encryptCookies(cookiesArray) {
  return encryptSecret(JSON.stringify(cookiesArray || []));
}
function decryptCookiesField(raw) {
  if (!raw) return [];
  try { return JSON.parse(decryptSecret(raw)); } catch (_) {}
  try { return JSON.parse(raw); } catch (_) { return []; }
}
// AI provider: Claude Fable 5 (best quality, needs paid ANTHROPIC_API_KEY) when available,
// otherwise free Groq (llama-3.1-8b-instant). The app works either way.
const Anthropic = require('@anthropic-ai/sdk');
const Groq      = require('groq-sdk');

const anthropicAI = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;
const groqAI = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;
const ai = anthropicAI || groqAI;

// Walk the string character-by-character to extract the first balanced { } block
function extractBalancedJSON(str) {
  const start = str.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    if (c === '}') { if (--depth === 0) return str.slice(start, i + 1); }
  }
  return null;
}

async function askClaude(prompt, maxTokens = 600) {
  if (anthropicAI) {
    const r = await anthropicAI.beta.messages.create({
      model: 'claude-fable-5',
      max_tokens: maxTokens,
      // Fable 5 thinking is always on — no thinking param to set.
      output_config: { effort: 'low' }, // short structured-extraction calls in a live chat UI; keep latency down
      betas: ['server-side-fallback-2026-06-01'],
      fallbacks: [{ model: 'claude-opus-4-8' }],
      messages: [{ role: 'user', content: prompt }],
    });
    if (r.stop_reason === 'refusal') throw new Error('Claude declined to respond to this request.');
    const textBlock = r.content.find(b => b.type === 'text');
    return (textBlock?.text || '').trim();
  }
  if (groqAI) {
    const r = await groqAI.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });
    return r.choices[0].message.content.trim();
  }
  throw new Error('No AI key set — add ANTHROPIC_API_KEY or GROQ_API_KEY to .env');
}

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── DATABASE ─────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'shadmansapi.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    name TEXT NOT NULL,
    google_id TEXT,
    avatar TEXT,
    plan TEXT DEFAULT 'free',
    plan_expires_at TEXT,
    is_verified INTEGER DEFAULT 0,
    verification_token TEXT,
    has_seen_plans INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS usage_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    workflow_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    url TEXT DEFAULT '',
    steps TEXT DEFAULT '[]',
    variables TEXT DEFAULT '[]',
    constants TEXT DEFAULT '{}',
    is_public INTEGER DEFAULT 0,
    price INTEGER DEFAULT 0,
    price_description TEXT DEFAULT '',
    call_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_run TEXT,
    session_cookies TEXT DEFAULT '[]',
    auth_mode TEXT DEFAULT 'shared',
    login_domain TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS site_credentials (
    user_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    email TEXT NOT NULL,
    password_enc TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, domain)
  );
  CREATE TABLE IF NOT EXISTS purchases (
    id TEXT PRIMARY KEY,
    buyer_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    seller_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    purchased_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS payment_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    plan TEXT NOT NULL,
    amount INTEGER NOT NULL,
    bkash_sender TEXT,
    bkash_transaction_id TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    processed_at TEXT
  );
`);
// Safely add session_cookies column if upgrading from an older DB
try { db.exec('ALTER TABLE workflows ADD COLUMN session_cookies TEXT DEFAULT "[]"'); } catch (_) {}
// Recordings uploaded from the Chrome extension, waiting for review in the web app (one per user)
db.exec(`
  CREATE TABLE IF NOT EXISTS pending_recordings (
    user_id TEXT PRIMARY KEY,
    steps TEXT NOT NULL,
    cookies TEXT DEFAULT '[]',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);
try { db.exec("ALTER TABLE pending_recordings ADD COLUMN cookies TEXT DEFAULT '[]'"); } catch (_) {}
try { db.exec("ALTER TABLE workflows ADD COLUMN auth_mode TEXT DEFAULT 'shared'"); } catch (_) {}
try { db.exec("ALTER TABLE workflows ADD COLUMN login_domain TEXT DEFAULT ''"); } catch (_) {}

// ─── EMAIL ────────────────────────────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

function sendEmail(to, subject, html) {
  return mailer.sendMail({
    from: `"Shadman's API" <${process.env.EMAIL_USER}>`,
    to, subject, html,
  }).catch(err => console.error('[Email]', err.message));
}

const emailBase = (body) => `
<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;background:#0f0f23;color:#e2e8f0;border-radius:16px;overflow:hidden;">
  <div style="background:linear-gradient(135deg,#312e81,#1e1b4b);padding:32px;text-align:center;">
    <h1 style="margin:0;font-size:28px;color:#a5b4fc;letter-spacing:-0.5px;">⚡ Shadman's API</h1>
    <p style="margin:4px 0 0;color:#6366f1;font-size:14px;">No-Code Automation Platform</p>
  </div>
  <div style="padding:32px;">${body}</div>
  <div style="padding:16px 32px;border-top:1px solid #1e1b4b;text-align:center;">
    <p style="margin:0;color:#475569;font-size:12px;">© 2026 Shadman's API · Built with ❤️ by Shadman Shadid Zim</p>
  </div>
</div>`;

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(session({ secret: process.env.SESSION_SECRET || 'shadmans-secret', resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(path.join(__dirname, 'public')));

// ─── PASSPORT ────────────────────────────────────────────────────────────────
passport.use(new LocalStrategy({ usernameField: 'email' }, (email, password, done) => {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user)             return done(null, false, { message: 'No account found with that email.' });
  if (!user.password_hash) return done(null, false, { message: 'This account uses Google Sign-In.' });
  if (!bcrypt.compareSync(password, user.password_hash)) return done(null, false, { message: 'Incorrect password.' });
  if (!user.is_verified) return done(null, false, { message: 'Please verify your email first. Check your inbox.' });
  return done(null, user);
}));

passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  '/auth/google/callback',
}, (accessToken, refreshToken, profile, done) => {
  const email  = profile.emails[0].value;
  const avatar = profile.photos[0]?.value;
  let user = db.prepare('SELECT * FROM users WHERE google_id = ? OR email = ?').get(profile.id, email);

  if (user) {
    if (!user.google_id) {
      db.prepare('UPDATE users SET google_id=?, avatar=?, is_verified=1 WHERE id=?').run(profile.id, avatar, user.id);
    }
    return done(null, db.prepare('SELECT * FROM users WHERE id = ?').get(user.id));
  }

  const id = uuidv4();
  db.prepare('INSERT INTO users (id,email,name,google_id,avatar,is_verified) VALUES (?,?,?,?,?,1)')
    .run(id, email, profile.displayName, profile.id, avatar);

  sendEmail(email, "Welcome to Shadman's API! 🎉", emailBase(`
    <h2 style="color:#a5b4fc;">Welcome, ${profile.displayName}! 👋</h2>
    <p>Your account is ready. You're on the <strong style="color:#6366f1;">Free Plan</strong> — 5 interactions per day.</p>
    <p style="margin-top:24px;">
      <a href="http://localhost:${PORT}" style="background:#6366f1;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;">
        Start Building →
      </a>
    </p>
  `));

  return done(null, db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => done(null, db.prepare('SELECT * FROM users WHERE id = ?').get(id)));

// ─── AUTH HELPERS ─────────────────────────────────────────────────────────────
function makeToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET || 'fallback-secret', { expiresIn: '7d' });
}

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Please log in.' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret');
    req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id);
    if (!req.user) return res.status(401).json({ error: 'Account not found.' });
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.email !== process.env.ADMIN_EMAIL) return res.status(403).json({ error: 'Admin only.' });
  next();
}

// ─── USAGE TRACKING ───────────────────────────────────────────────────────────
const LIMITS = { free: { daily: 5 }, monthly: { monthly: 500 }, yearly: { monthly: Infinity } };

function checkUsageLimit(req, res, next) {
  const u   = req.user;
  const now = new Date();

  if (u.plan !== 'free' && u.plan_expires_at && new Date(u.plan_expires_at) < now) {
    db.prepare('UPDATE users SET plan=? WHERE id=?').run('free', u.id);
    req.user.plan = 'free';
  }

  if (u.plan === 'free') {
    const dayStart = new Date(now); dayStart.setHours(0,0,0,0);
    const count = db.prepare('SELECT COUNT(*) as c FROM usage_logs WHERE user_id=? AND created_at>=?')
      .get(u.id, dayStart.toISOString()).c;
    if (count >= 5) return res.status(429).json({
      error: "Today's limit reached! You've used all 5 free interactions. Upgrade for more.",
      limitReached: true, upgradeRequired: true,
    });
  } else if (u.plan === 'monthly') {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const count = db.prepare('SELECT COUNT(*) as c FROM usage_logs WHERE user_id=? AND created_at>=?')
      .get(u.id, monthStart.toISOString()).c;
    if (count >= 500) return res.status(429).json({
      error: "Monthly limit reached! You've used 500 interactions. Upgrade to Yearly for unlimited.",
      limitReached: true, upgradeRequired: true,
    });
  }
  next();
}

function logUsage(userId, actionType, workflowId = null) {
  db.prepare('INSERT INTO usage_logs (id,user_id,action_type,workflow_id) VALUES (?,?,?,?)')
    .run(uuidv4(), userId, actionType, workflowId);
}

// ─── AUTH ROUTES ──────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Please fill in all fields.' });
  if (password.length < 6)          return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) {
    return res.status(400).json({ error: 'An account with this email already exists. Please log in.' });
  }

  const id                = uuidv4();
  const verificationToken = uuidv4();
  db.prepare('INSERT INTO users (id,email,password_hash,name,verification_token,is_verified) VALUES (?,?,?,?,?,0)')
    .run(id, email, bcrypt.hashSync(password, 10), name, verificationToken);

  const link = `http://localhost:${PORT}/verify-email?token=${verificationToken}`;
  await sendEmail(email, "Verify your Shadman's API account ✅", emailBase(`
    <h2 style="color:#a5b4fc;">Almost there, ${name}! 🚀</h2>
    <p style="color:#94a3b8;">Click the button below to verify your email and activate your account.</p>
    <p style="margin:28px 0;text-align:center;">
      <a href="${link}" style="background:#6366f1;color:white;padding:14px 32px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:bold;">
        ✅ Verify My Email
      </a>
    </p>
    <p style="color:#475569;font-size:13px;">If you didn't sign up, you can safely ignore this email.</p>
  `));

  res.json({ success: true, message: "Account created! We've sent a verification link to your email. Check your inbox." });
});

app.get('/verify-email', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE verification_token=?').get(req.query.token);
  if (!user) return res.redirect('/?error=bad-token');
  db.prepare('UPDATE users SET is_verified=1, verification_token=NULL WHERE id=?').run(user.id);
  res.redirect('/?verified=1');
});

app.post('/api/auth/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err)   return next(err);
    if (!user) return res.status(401).json({ error: info?.message || 'Login failed.' });
    res.json({ success: true, token: makeToken(user), user: safeUser(user) });
  })(req, res, next);
});

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=google-failed' }),
  (req, res) => res.redirect(`/?token=${makeToken(req.user)}`)
);

app.get('/api/auth/me', requireAuth, (req, res) => {
  const u         = req.user;
  const now       = new Date();
  const dayStart  = new Date(now); dayStart.setHours(0,0,0,0);
  const monthStart= new Date(now.getFullYear(), now.getMonth(), 1);
  const todayUse  = db.prepare('SELECT COUNT(*) as c FROM usage_logs WHERE user_id=? AND created_at>=?').get(u.id, dayStart.toISOString()).c;
  const monthUse  = db.prepare('SELECT COUNT(*) as c FROM usage_logs WHERE user_id=? AND created_at>=?').get(u.id, monthStart.toISOString()).c;
  const apiCount  = db.prepare('SELECT COUNT(*) as c FROM workflows WHERE user_id=?').get(u.id).c;
  const totalCalls= db.prepare('SELECT COALESCE(SUM(call_count),0) as c FROM workflows WHERE user_id=?').get(u.id).c;
  res.json({ ...safeUser(u), usage: { today: todayUse, month: monthUse }, stats: { apiCount, totalCalls } });
});

app.post('/api/auth/mark-plans-seen', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET has_seen_plans=1 WHERE id=?').run(req.user.id);
  res.json({ success: true });
});

function safeUser(u) {
  return { id: u.id, name: u.name, email: u.email, plan: u.plan, avatar: u.avatar, plan_expires_at: u.plan_expires_at, has_seen_plans: u.has_seen_plans };
}

// ─── SITE CREDENTIALS (per-user logins for "each user connects their own account" APIs) ──────
// Passwords are encrypted (see encryptSecret/decryptSecret) and NEVER sent back to the client.
app.get('/api/credentials', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT domain, email, updated_at FROM site_credentials WHERE user_id=?').all(req.user.id);
  res.json(rows);
});

app.post('/api/credentials', requireAuth, (req, res) => {
  const { domain, email, password } = req.body;
  if (!domain || !email || !password) return res.status(400).json({ error: 'Domain, email, and password are all required.' });
  const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  db.prepare(`INSERT INTO site_credentials (user_id, domain, email, password_enc, updated_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)
              ON CONFLICT(user_id, domain) DO UPDATE SET email=excluded.email, password_enc=excluded.password_enc, updated_at=CURRENT_TIMESTAMP`)
    .run(req.user.id, cleanDomain, email, encryptSecret(password));
  res.json({ success: true });
});

app.delete('/api/credentials/:domain', requireAuth, (req, res) => {
  db.prepare('DELETE FROM site_credentials WHERE user_id=? AND domain=?').run(req.user.id, req.params.domain);
  res.json({ success: true });
});

// ─── PAYMENT ROUTES ───────────────────────────────────────────────────────────
const PRICES = { monthly: 299, yearly: 2499 };

app.post('/api/payment/initiate', requireAuth, (req, res) => {
  const { plan, bkash_sender, bkash_transaction_id } = req.body;
  if (!PRICES[plan])                      return res.status(400).json({ error: 'Invalid plan selected.' });
  if (!bkash_sender || !bkash_transaction_id) return res.status(400).json({ error: 'Please provide your bKash number and Transaction ID.' });

  const id = uuidv4();
  db.prepare('INSERT INTO payment_requests (id,user_id,plan,amount,bkash_sender,bkash_transaction_id) VALUES (?,?,?,?,?,?)')
    .run(id, req.user.id, plan, PRICES[plan], bkash_sender, bkash_transaction_id);

  sendEmail(process.env.ADMIN_EMAIL, `💰 New Payment — ${plan} — ৳${PRICES[plan]}`, emailBase(`
    <h2 style="color:#f59e0b;">New Payment Request</h2>
    <table style="width:100%;border-collapse:collapse;color:#e2e8f0;">
      <tr><td style="padding:8px 0;color:#94a3b8;">User</td><td><strong>${req.user.name}</strong> (${req.user.email})</td></tr>
      <tr><td style="padding:8px 0;color:#94a3b8;">Plan</td><td><strong style="color:#6366f1;">${plan} — ৳${PRICES[plan]}</strong></td></tr>
      <tr><td style="padding:8px 0;color:#94a3b8;">bKash Number</td><td>${bkash_sender}</td></tr>
      <tr><td style="padding:8px 0;color:#94a3b8;">Transaction ID</td><td><strong>${bkash_transaction_id}</strong></td></tr>
      <tr><td style="padding:8px 0;color:#94a3b8;">Request ID</td><td style="font-size:12px;">${id}</td></tr>
    </table>
    <p style="margin-top:24px;">
      <a href="http://localhost:${PORT}/#admin" style="background:#6366f1;color:white;padding:10px 24px;border-radius:8px;text-decoration:none;">
        Open Admin Panel →
      </a>
    </p>
  `));

  res.json({ success: true, message: 'Payment request submitted! We will verify within a few hours and activate your plan.' });
});

app.get('/api/admin/payments', requireAuth, requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT pr.*, u.name as user_name, u.email as user_email
    FROM payment_requests pr JOIN users u ON pr.user_id = u.id
    ORDER BY pr.created_at DESC
  `).all());
});

app.post('/api/admin/payments/:id/approve', requireAuth, requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM payment_requests WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found.' });

  const expires = new Date();
  if (p.plan === 'monthly') expires.setMonth(expires.getMonth() + 1);
  else expires.setFullYear(expires.getFullYear() + 1);

  db.prepare("UPDATE users SET plan=?, plan_expires_at=? WHERE id=?").run(p.plan, expires.toISOString(), p.user_id);
  db.prepare("UPDATE payment_requests SET status='approved', processed_at=CURRENT_TIMESTAMP WHERE id=?").run(p.id);

  const u = db.prepare('SELECT * FROM users WHERE id=?').get(p.user_id);
  sendEmail(u.email, "✅ Your plan is now active!", emailBase(`
    <h2 style="color:#10b981;">Your ${p.plan} plan is active! 🎉</h2>
    <p>Payment of <strong>৳${p.amount}</strong> has been confirmed.</p>
    <p>Your plan is valid until <strong style="color:#a5b4fc;">${expires.toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' })}</strong>.</p>
    <p style="margin-top:24px;"><a href="http://localhost:${PORT}" style="background:#6366f1;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;">Start Building →</a></p>
  `));

  res.json({ success: true });
});

app.post('/api/admin/payments/:id/reject', requireAuth, requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM payment_requests WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found.' });
  db.prepare("UPDATE payment_requests SET status='rejected', processed_at=CURRENT_TIMESTAMP WHERE id=?").run(p.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(p.user_id);
  sendEmail(u.email, "Payment Verification Issue — Shadman's API", emailBase(`
    <h2 style="color:#ef4444;">Payment Not Verified</h2>
    <p>We couldn't verify your payment (Transaction ID: <strong>${p.bkash_transaction_id}</strong>).</p>
    <p>Please contact us at <a href="mailto:${process.env.ADMIN_EMAIL}" style="color:#6366f1;">${process.env.ADMIN_EMAIL}</a> with your bKash screenshot.</p>
  `));
  res.json({ success: true });
});

// ─── RECORDING ENGINE ─────────────────────────────────────────────────────────
const activeSessions = new Map();

app.post('/api/recording/start', requireAuth, checkUsageLimit, async (req, res) => {
  const sessionId = uuidv4();
  const steps     = [];
  let lastNavAt   = Date.now(); // used to give AJAX-loaded widgets time to settle before treating them as user edits

  try {
    const browser = await puppeteer.launch({
      headless: false,
      defaultViewport: null,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized'],
    });

    const [page] = await browser.pages();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');

    await page.exposeFunction('__recordAction', (action) => {
      steps.push({ ...action, timestamp: Date.now() });
    });

    let sessionStopped = false;
    await page.exposeFunction('__stopRecording', async () => {
      if (sessionStopped) return;
      sessionStopped = true;
      try { await browser.close(); } catch (_) {}
      activeSessions.set(sessionId, { stopped: true, steps });
    });

    const injectRecorder = async (frame) => {
      try {
        await frame.evaluate(() => {
          if (document.getElementById('__sapi_bar')) return;

          // Toolbar
          const bar = document.createElement('div');
          bar.id = '__sapi_bar';
          bar.style.cssText = [
            'position:fixed','top:0','left:0','right:0','z-index:2147483647',
            'background:linear-gradient(90deg,#1e1b4b,#312e81)',
            'color:white','padding:8px 16px','display:flex','align-items:center',
            'gap:12px','font-family:Arial,sans-serif','font-size:13px',
            'box-shadow:0 2px 12px rgba(0,0,0,0.5)','user-select:none',
          ].join(';');
          bar.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;">
              <div style="width:9px;height:9px;border-radius:50%;background:#ef4444;animation:__sapiB 1s infinite"></div>
              <strong style="color:#a5b4fc;font-size:14px;">Shadman's API</strong>
              <span style="color:#94a3b8;">— Recording your actions</span>
            </div>
            <span id="__sapi_count" style="color:#6366f1;font-weight:bold;margin-left:8px;">0 actions</span>
            <button id="__sapi_stop" style="margin-left:auto;background:#ef4444;color:white;border:none;padding:7px 18px;border-radius:6px;cursor:pointer;font-weight:bold;font-size:13px;">
              ⏹ Stop & Save
            </button>
            <style>@keyframes __sapiB{0%,100%{opacity:1}50%{opacity:.2}}</style>
          `;
          document.body.style.paddingTop = '42px';
          document.body.prepend(bar);
          document.getElementById('__sapi_stop').onclick = () => window.__stopRecording();

          const generateSelector = (el) => {
            if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) return `#${el.id}`;
            if (el.name) return `[name="${el.name}"]`;
            const tag = el.tagName.toLowerCase();
            if (el.placeholder) return `${tag}[placeholder="${el.placeholder}"]`;
            if (el.className && typeof el.className === 'string') {
              // Utility-CSS frameworks (Tailwind etc.) emit class tokens like "text-[#141B34]" or
              // "hover:text-sm" that contain characters CSS selectors can't parse unescaped — skip those.
              const cls = el.className.split(' ').find(c => /^[a-zA-Z][\w-]*$/.test(c));
              if (cls) return `${tag}.${cls}`;
            }
            return tag;
          };

          // Radio/checkbox group members all share the same [name], so generateSelector() alone
          // would match every option in the group — this picks out just the one clicked.
          const generateOptionSelector = (el) => {
            if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) return `#${el.id}`;
            if (el.name && el.value) return `input[name="${el.name}"][value="${el.value.replace(/"/g, '\\"')}"]`;
            return generateSelector(el);
          };

          // Some sites reuse the exact same [name] across multiple UNRELATED radio groups (seen on
          // ShareTrip: trip-type, fare-type, and cabin-class radios all literally named
          // "radio-group") — a document-wide query would then merge them into one nonsensical
          // combined option list. Real groups are always tightly nested together in practice, so
          // the smallest ancestor that contains more than one same-name match is the true group;
          // climbing further would only start sweeping in an unrelated group further up the tree.
          const findGroupScope = (el, name) => {
            let scope = el.parentElement;
            for (let i = 0; i < 8 && scope; i++) {
              if (scope.querySelectorAll(`input[name="${CSS.escape(name)}"]`).length > 1) return scope;
              scope = scope.parentElement;
            }
            return document;
          };

          const getLabel = (el) =>
            el.getAttribute('aria-label') || el.placeholder || el.name || el.id ||
            (el.textContent || '').trim().substring(0, 30) || el.tagName.toLowerCase();

          const getOptionLabel = (el) => {
            if (el.id) {
              const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
              if (lab) return lab.textContent.trim().slice(0, 60);
            }
            const wrapLabel = el.closest('label');
            if (wrapLabel) return wrapLabel.textContent.trim().slice(0, 60);
            return getLabel(el);
          };

          let actionCount = 0;
          const updateCount = () => {
            const el = document.getElementById('__sapi_count');
            if (el) el.textContent = `${++actionCount} action${actionCount === 1 ? '' : 's'}`;
          };

          // Class-based selectors often match several elements (e.g. min & max salary boxes both
          // being "input.border"). Record which match this element is, so replay targets the right one.
          const getMatchIndex = (el, sel) => {
            try {
              const m = document.querySelectorAll(sel);
              if (m.length > 1) return Math.max(0, Array.from(m).indexOf(el));
            } catch (_) {}
            return 0;
          };

          // Post-click snapshot: fires 600ms AFTER each click so autocomplete/React fills are included.
          // Radio/checkbox inputs are excluded — their .value is a static option code (e.g. an author ID or
          // sort key) that exists whether or not the box is checked, so scanning them floods the recording
          // with dozens of untouched filter options. Actual checkbox/radio toggles are still captured by the click handler.
          const FIELD_SELECTOR = 'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]';
          const getVal = el => (el.value !== undefined && el.value !== null) ? el.value : (el.textContent || '').trim();
          const fieldSnapshot = new Map(); // selector → last recorded value

          // Some widgets (nav mega-menus, price/discount sliders) attach to the DOM via AJAX a second or two
          // after navigation — later than our initial seed pass. So instead of seeding once, we treat any
          // field discovered before this settle deadline as a baseline default (silently), not a user edit.
          // Only changes seen AFTER the page has settled count as something the user actually typed.
          const settleUntil = Date.now() + 1800;

          document.querySelectorAll(FIELD_SELECTOR).forEach(el => {
            if (el.closest('#__sapi_bar')) return;
            const val = getVal(el);
            if (val) { const s = generateSelector(el); fieldSnapshot.set(s + '|' + getMatchIndex(el, s), val); }
          });

          const snapshotAll = () => {
            const settling = Date.now() < settleUntil;
            document.querySelectorAll(FIELD_SELECTOR).forEach(el => {
              if (el.closest('#__sapi_bar')) return;
              // Invisible fields are analytics/tracking forms the site fills in the background — never user input
              if (el.offsetWidth === 0 && el.offsetHeight === 0) return;
              const val = getVal(el);
              if (!val || val.length > 300) return;
              const sel = generateSelector(el);
              const mi  = getMatchIndex(el, sel);
              const key = sel + '|' + mi;
              if (fieldSnapshot.get(key) === val) return;
              fieldSnapshot.set(key, val);
              if (settling) return; // still-loading widget catching up to its default — not a real edit
              window.__recordAction({ type: 'fill', selector: sel, matchIndex: mi, value: val, label: getLabel(el), inputType: el.type || 'text', tag: el.tagName.toLowerCase(), autocomplete: true });
              updateCount();
            });
          };

          document.addEventListener('click', (e) => {
            if (e.target.closest('#__sapi_bar')) return;

            // Filter panels (location, category, job type, etc.) are almost always a group of
            // radio/checkbox inputs sharing one [name]. Capture every option in the group — not just
            // the one clicked — so replay can later pick a DIFFERENT option based on what's asked for.
            let optionInput = null;
            if (e.target.tagName === 'INPUT' && (e.target.type === 'radio' || e.target.type === 'checkbox')) {
              optionInput = e.target;
            } else {
              const wrapLabel = e.target.closest('label');
              if (wrapLabel) optionInput = wrapLabel.querySelector('input[type="radio"], input[type="checkbox"]');
            }
            if (optionInput && optionInput.name) {
              const groupScope = findGroupScope(optionInput, optionInput.name);
              const groupEls = Array.from(groupScope.querySelectorAll(`input[name="${CSS.escape(optionInput.name)}"]`));
              if (groupEls.length > 1) {
                // The raw [name] attribute is often generic or even reused across unrelated
                // groups on the same page (e.g. ShareTrip literally names trip-type, fare-type,
                // and cabin-class radios all "radio-group") — useless, and not even guaranteed
                // unique, as a human/AI-facing label. The option text itself is always
                // meaningfully distinct, so summarize the group by its own options instead.
                const optLabels = groupEls.map(el => getOptionLabel(el)).filter(Boolean);
                const groupLabel = optLabels.slice(0, 3).join(' / ').slice(0, 60) || optionInput.name;
                window.__recordAction({
                  type: 'choice',
                  groupName: groupLabel,
                  options: groupEls.map(el => ({ selector: generateOptionSelector(el), label: getOptionLabel(el), value: el.value })),
                  selectedSelector: generateOptionSelector(optionInput),
                  selectedLabel: getOptionLabel(optionInput),
                  label: groupLabel,
                });
                updateCount();
                return;
              }
            }

            // A standalone checkbox (no group) is an on/off toggle — e.g. "Fresher only",
            // "Free shipping", "Include out of stock". Recorded with its post-click state so
            // the AI can later flip it either way ("only fresher jobs" → on).
            if (optionInput && optionInput.type === 'checkbox') {
              const ts = generateOptionSelector(optionInput);
              window.__recordAction({ type: 'toggle', selector: ts, matchIndex: getMatchIndex(optionInput, ts), newState: optionInput.checked, label: getOptionLabel(optionInput) });
              updateCount();
              return;
            }

            // Some app-built filter menus (React/Angular dropdown panels) have no real form inputs
            // behind them at all — just a list of clickable text items with app-internal state.
            // Detect that shape (a clicked list item with 2+ text siblings) and match by visible text
            // at replay time instead of a selector, since there's no [name]/[value] to key off.
            // Accessible ARIA radio groups (role="radio" inside role="radiogroup") — a common
            // pattern for custom-styled radio buttons (Google Forms among many others) that
            // native input[type=radio] detection above doesn't see at all. data-value (when
            // present) is a clean option label; aria-label is often noisy (a full sentence with
            // a duplicated description appended after a comma), so prefer data-value and trim
            // aria-label at the first comma as a fallback.
            const ariaRadioEl = e.target.closest('[role="radio"]');
            if (ariaRadioEl && !optionInput) {
              const group = ariaRadioEl.closest('[role="radiogroup"]') || ariaRadioEl.parentElement;
              const getAriaRadioLabel = (el) => {
                const dv = el.getAttribute('data-value');
                if (dv) return dv.trim().slice(0, 60);
                const al = el.getAttribute('aria-label');
                if (al) return al.split(',')[0].trim().slice(0, 60);
                return el.textContent.trim().slice(0, 60);
              };
              const radios = group ? Array.from(group.querySelectorAll('[role="radio"]')) : [ariaRadioEl];
              if (radios.length > 1) {
                const options = [...new Set(radios.map(getAriaRadioLabel))].filter(Boolean);
                if (options.length > 1) {
                  window.__recordAction({
                    type: 'choice',
                    mode: 'text',
                    groupName: group?.getAttribute('aria-label') || 'Option',
                    options: options.map(label => ({ label })),
                    selectedLabel: getAriaRadioLabel(ariaRadioEl),
                    label: group?.getAttribute('aria-label') || 'Option',
                  });
                  updateCount();
                  return;
                }
              }
            }

            // Calendar date-cell pick — accessible date pickers (MUI X Date Pickers among many
            // others) commonly label each day cell with a full, parseable date in aria-label
            // (e.g. "Wednesday, August 5, 2026", sometimes prefixed with availability text). This
            // is a much more reliable signal than position: which cell holds "the 5th" shifts
            // every month, and which month is even showing depends on today's date, so a
            // positional/selector-based replay would drift the moment the workflow is reused on a
            // different day. Recorded as a portable calendar date instead of a DOM position.
            const DATE_LABEL_RE = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i;
            const dateLabelEl = e.target.closest('[aria-label]');
            if (dateLabelEl && !optionInput) {
              const m = (dateLabelEl.getAttribute('aria-label') || '').match(DATE_LABEL_RE);
              if (m) {
                const iso = new Date(`${m[1]} ${m[2]}, ${m[3]}`).toISOString().slice(0, 10);
                if (!isNaN(new Date(iso))) {
                  window.__recordAction({ type: 'date', value: iso, label: 'Date' });
                  updateCount();
                  return;
                }
              }
            }

            // ARIA combobox / typeahead suggestion pick (role="combobox" input with
            // aria-expanded/aria-controls driving a live, dynamically-generated option list) —
            // extremely common for location/search-as-you-type fields (airport pickers, address
            // fields, tag inputs...). Unlike a static filter menu, the options here only exist
            // because of whatever text was just typed — hardcoding the recorded option list would
            // break the moment a DIFFERENT value is requested at replay (e.g. typing "Kolkata"
            // shows only Kolkata airports; asking for "Chennai" later would match nothing against
            // that stale list). Recorded instead as "typed into field X, picked a suggestion" —
            // replay re-types the requested value fresh and clicks whatever suggestion comes back.
            const optionRoleEl = e.target.closest('[role="option"]');
            if (optionRoleEl && !optionInput) {
              const comboEl = document.querySelector('[role="combobox"][aria-expanded="true"]');
              if (comboEl) {
                const cs = generateSelector(comboEl);
                window.__recordAction({
                  type: 'autocomplete',
                  selector: cs,
                  matchIndex: getMatchIndex(comboEl, cs),
                  value: comboEl.value || '',
                  selectedLabel: optionRoleEl.textContent.trim().slice(0, 80),
                  label: getLabel(comboEl),
                });
                updateCount();
                return;
              }
            }

            // Numeric stepper / quantity selector (e.g. traveller-count pickers, ticket/quantity
            // pickers) — a clicked button sitting in a strict 3-sibling row [button, number,
            // button]. No ARIA convention exists for this at all (unlike radio/checkbox/combobox/
            // date — these +/- icon buttons carry no aria-label), but the exact 3-child shape is
            // itself a common, reliable structural signal for quantity pickers across many
            // frameworks/sites, and strict enough not to misfire on unrelated things like
            // pagination bars (which have more than 3 children: prev, several page numbers, next).
            // Checked BEFORE the generic list/option detector below, which would otherwise
            // misinterpret a stepper's whole row-list as a static multi-choice pick — recording a
            // confusing new "choice" variable on every click instead of recognizing it as one
            // count that goes up or down.
            if (!optionInput) {
              const btnEl = e.target.closest('button');
              const sibs = btnEl && btnEl.parentElement ? Array.from(btnEl.parentElement.children) : [];
              if (btnEl && sibs.length === 3) {
                const idx = sibs.indexOf(btnEl);
                const numEl = sibs[1] !== btnEl && /^\d+$/.test((sibs[1].textContent || '').trim()) ? sibs[1] : null;
                const otherBtn = numEl && idx !== 1 ? sibs.find(s => s.tagName === 'BUTTON' && s !== btnEl) : null;
                if (numEl && otherBtn) {
                  const before = parseInt(numEl.textContent.trim(), 10);
                  const rowEl = btnEl.closest('li, tr, [role="row"]') || btnEl.parentElement.parentElement;
                  const rowLabel = ((rowEl && rowEl.querySelector('p,span,label')) ? rowEl.querySelector('p,span,label').textContent : getLabel(btnEl)).trim().slice(0, 40);
                  const btnSel = generateSelector(btnEl), otherSel = generateSelector(otherBtn), numSel = generateSelector(numEl);
                  const btnMi = getMatchIndex(btnEl, btnSel), otherMi = getMatchIndex(otherBtn, otherSel), numMi = getMatchIndex(numEl, numSel);
                  setTimeout(() => {
                    const allNum = document.querySelectorAll(numSel);
                    const afterEl = allNum[Math.min(numMi, allNum.length - 1)];
                    const after = afterEl ? parseInt(afterEl.textContent.trim(), 10) : NaN;
                    if (!isNaN(before) && !isNaN(after) && before !== after) {
                      window.__recordAction({
                        type: 'stepper',
                        label: rowLabel || 'Count',
                        incSelector: after > before ? btnSel : otherSel,
                        incMatchIndex: after > before ? btnMi : otherMi,
                        decSelector: after > before ? otherSel : btnSel,
                        decMatchIndex: after > before ? otherMi : btnMi,
                        countSelector: numSel,
                        countMatchIndex: numMi,
                        value: after,
                      });
                      updateCount();
                    }
                  }, 250);
                  return;
                }
              }
            }

            const optionEl = e.target.closest('li, [role="option"], [role="menuitem"]');
            if (optionEl && !optionInput) {
              const container = optionEl.parentElement;
              const getItemLabel = (el) => {
                const lab = el.querySelector('label');
                return (lab ? lab.textContent : el.textContent).trim().slice(0, 60);
              };
              if (container && container.children.length > 1) {
                const options = [...new Set(Array.from(container.children).map(getItemLabel))].filter(t => t && t.length < 60);
                if (options.length > 1) {
                  window.__recordAction({
                    type: 'choice',
                    mode: 'text',
                    groupName: 'Option',
                    options: options.map(label => ({ label })),
                    selectedLabel: getItemLabel(optionEl),
                    label: 'Option',
                  });
                  updateCount();
                  return;
                }
              }
            }

            // Accessible ARIA checkboxes (role="checkbox") — same custom-widget pattern as the
            // ARIA radio group above (Google Forms' "Checkboxes" question type, among others),
            // invisible to native input[type=checkbox] detection. These are independent
            // multi-select toggles, not a mutually-exclusive group, so each is recorded as its
            // own toggle step, matched by label text at replay (no real selector exists).
            // aria-checked is read after a short delay in case the widget's own state update
            // isn't synchronous with this capture-phase listener.
            const ariaCheckboxEl = e.target.closest('[role="checkbox"]');
            if (ariaCheckboxEl && !optionInput) {
              const dv = ariaCheckboxEl.getAttribute('data-value');
              const al = ariaCheckboxEl.getAttribute('aria-label');
              const label = (dv || (al ? al.split(',')[0] : '') || ariaCheckboxEl.textContent).trim().slice(0, 60);
              setTimeout(() => {
                window.__recordAction({ type: 'toggle', mode: 'text', label: label || 'Option', newState: ariaCheckboxEl.getAttribute('aria-checked') === 'true' });
                updateCount();
              }, 50);
              return;
            }

            // Clicks often land on a tiny icon inside a real control — an <svg>/<path>/<use>/<i>
            // with no stable identity of its own (selector "path", matchIndex 108...), un-refindable
            // at replay so the click misses (this is what broke ShareTrip's Search button, making the
            // whole run fall back to the recorded default URL). Retarget to the nearest genuinely
            // clickable ancestor so the recorded selector points at the control the user meant.
            let clickTarget = e.target;
            if (/^(svg|path|use|i|img|span)$/i.test(clickTarget.tagName)) {
              const real = clickTarget.closest('button, a, [role="button"], [type="submit"], input[type="submit"]');
              if (real) clickTarget = real;
            }
            const sel = generateSelector(clickTarget);
            window.__recordAction({ type: 'click', selector: sel, matchIndex: getMatchIndex(clickTarget, sel), tag: clickTarget.tagName.toLowerCase(), label: getLabel(clickTarget) });
            updateCount();
            // Snapshot AFTER click so autocomplete fills and React state updates are captured
            setTimeout(snapshotAll, 600);
          }, true);

          // Native <input type="range"> sliders fire 'change' on release.
          document.addEventListener('change', (e) => {
            const el = e.target;
            if (Date.now() < settleUntil) return;
            if (el.tagName === 'INPUT' && el.type === 'range') {
              const s = generateSelector(el);
              window.__recordAction({ type: 'slider', selector: s, matchIndex: getMatchIndex(el, s), value: el.value, min: el.min || '0', max: el.max || '100', label: getLabel(el) });
              updateCount();
            }
          }, true);

          // Custom drag-slider widgets (noUiSlider, rc-slider, MUI, etc.) expose position via
          // aria-valuenow on a [role="slider"] element rather than a real <input>. Debounce so we
          // only record the settled value once the user releases the handle, not every drag tick.
          const sliderDebounce = new Map();
          const recordSliderChange = (el) => {
            if (Date.now() < settleUntil) return;
            const val = el.getAttribute('aria-valuenow');
            if (val == null) return;
            const s = generateSelector(el);
            window.__recordAction({
              type: 'slider', selector: s, matchIndex: getMatchIndex(el, s), value: val,
              min: el.getAttribute('aria-valuemin') || '0', max: el.getAttribute('aria-valuemax') || '100',
              label: el.getAttribute('aria-label') || getLabel(el),
            });
            updateCount();
          };
          new MutationObserver((mutations) => {
            const touched = new Set();
            for (const m of mutations) {
              if (m.attributeName === 'aria-valuenow' && m.target.getAttribute('role') === 'slider' && !touched.has(m.target)) {
                touched.add(m.target);
                const el = m.target;
                const sel = generateSelector(el);
                const key = sel + '|' + getMatchIndex(el, sel);
                clearTimeout(sliderDebounce.get(key));
                sliderDebounce.set(key, setTimeout(() => recordSliderChange(el), 500));
              }
            }
          }).observe(document.body, { attributes: true, attributeFilter: ['aria-valuenow'], subtree: true });

          // Snapshot when focus leaves a field (catches typing without clicking away). Read now —
          // focusout only fires once you've genuinely left the field (unlike 'click', which can
          // also fire from a framework's own internal interactions mid-typing and would capture
          // an incomplete value) — then again shortly after in case the page reformats/validates
          // the value right after blur.
          document.addEventListener('focusout', (e) => {
            const el = e.target;
            if (!['INPUT','TEXTAREA'].includes(el.tagName) && !el.isContentEditable) return;
            if (el.closest('#__sapi_bar')) return;
            snapshotAll();
            setTimeout(snapshotAll, 300);
          }, true);

          // Snapshot on Tab/Enter in case user navigates with keyboard
          document.addEventListener('keydown', (e) => {
            if (e.key === 'Tab' || e.key === 'Enter') setTimeout(snapshotAll, 300);
          }, true);
        });
      } catch (_) {}
    };

    page.on('framenavigated', async (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (!url || url === 'about:blank') return;
      steps.push({ type: 'navigate', url, timestamp: Date.now() });
      lastNavAt = Date.now();
      await new Promise(r => setTimeout(r, 600));
      await injectRecorder(frame);
    });

    // Start screen — with a direct URL bar so users never type in Chrome's address bar (which goes to Google)
    await page.evaluate(() => {
      document.body.style.cssText = 'margin:0;background:#0f0f23;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:Arial,sans-serif;';
      document.body.innerHTML = `
        <div style="padding:32px;max-width:580px;width:100%;">
          <div style="text-align:center;margin-bottom:24px;">
            <div style="font-size:48px;margin-bottom:10px;">🎙️</div>
            <h1 style="color:#a5b4fc;font-size:22px;margin:0 0 6px;">Recording Started</h1>
            <p style="color:#64748b;font-size:13px;margin:0;">Use the box below to open a website — don't type in Chrome's address bar</p>
          </div>

          <div style="background:#1e1b4b;border:2px solid #6366f1;border-radius:14px;padding:20px;margin-bottom:20px;">
            <p style="margin:0 0 10px;color:#a5b4fc;font-weight:bold;font-size:14px;">🌐 Step 1 — Open the website you want to record:</p>
            <div style="display:flex;gap:8px;">
              <input id="__sapi_url" type="text" placeholder="rokomari.com  or  bdjobs.com  or  daraz.com.bd"
                style="flex:1;padding:10px 14px;border-radius:8px;border:1px solid #4338ca;background:#0f0f23;color:white;font-size:14px;outline:none;" />
              <button id="__sapi_go"
                style="background:#6366f1;color:white;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-weight:bold;font-size:14px;white-space:nowrap;">
                Go →
              </button>
            </div>
            <p style="margin:8px 0 0;color:#475569;font-size:11px;">⚡ This opens the site directly — no Google in between</p>
          </div>

          <div style="background:#1a1a3e;border:1px solid #312e81;border-radius:12px;padding:16px;margin-bottom:16px;font-size:13px;">
            <p style="margin:0 0 8px;color:#6366f1;font-weight:bold;">📋 Step 2 — Do your task on the website:</p>
            <p style="margin:4px 0;color:#94a3b8;">• Search for a product, flight, job, stock — whatever you want to automate</p>
            <p style="margin:4px 0;color:#94a3b8;">• Fill in the form fields, click buttons — everything is captured</p>
            <p style="margin:4px 0;color:#94a3b8;">• When done, click <strong style="color:#ef4444;">⏹ Stop & Save</strong> in the toolbar above</p>
          </div>

          <div style="background:#0a1a0a;border:1px solid #166534;border-radius:12px;padding:14px;font-size:12px;color:#86efac;">
            ✅ <strong>Sites that work well:</strong> rokomari.com · bdjobs.com · daraz.com.bd · dsebd.org · imdb.com · chaldal.com
          </div>
        </div>`;

      document.getElementById('__sapi_go').onclick = () => {
        let url = document.getElementById('__sapi_url').value.trim();
        if (!url) return;
        // Strip accidental http prefix typos then rebuild
        url = url.replace(/^https?:\/\//i, '');
        // If no dot in the hostname part, assume .com (e.g. "rokomari" → "rokomari.com")
        const hostPart = url.split('/')[0];
        if (!hostPart.includes('.')) url = url + '.com';
        url = 'https://' + url;
        window.location.href = url;
      };
      document.getElementById('__sapi_url').addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('__sapi_go').click();
      });
    });

    activeSessions.set(sessionId, { browser, page, steps, stopped: false });

    // Server-side field polling — catches React inputs, autocomplete, date pickers.
    // Runs every 600ms from Node.js, bypassing browser event issues entirely.
    const lastFieldVals = new Map();
    const fieldPoller = setInterval(async () => {
      const sess = activeSessions.get(sessionId);
      if (!sess || sess.stopped) { clearInterval(fieldPoller); return; }
      try {
        const pages = await browser.pages().catch(() => []);
        const pg = pages.find(p => !p.url().includes('about:blank') && !p.url().includes('devtools')) || pages[0];
        if (!pg) return;
        const fields = await pg.evaluate(() => {
          const sel = el => {
            const al = el.getAttribute('aria-label');
            if (al) return `[aria-label="${al.replace(/"/g,"'")}"]`;
            if (el.id) return `#${el.id}`;
            if (el.name) return `[name="${el.name}"]`;
            if (el.placeholder) return `[placeholder="${el.placeholder.replace(/"/g,"'")}"]`;
            let s = el.tagName.toLowerCase();
            const cls = Array.from(el.classList).filter(c => !c.match(/^(ng-|js-|is-|has-)/)).slice(0,2).join('.');
            return cls ? `${s}.${cls}` : s;
          };
          const matchIndex = (el, s) => {
            try { const m = document.querySelectorAll(s); if (m.length > 1) return Math.max(0, Array.from(m).indexOf(el)); } catch (_) {}
            return 0;
          };
          return Array.from(document.querySelectorAll(
            'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="radio"]):not([type="checkbox"]), textarea, [role="textbox"], [role="searchbox"], [role="combobox"]'
          ))
          .filter(el => !el.closest('#__sapi_bar') && (el.offsetWidth > 0 || el.offsetHeight > 0))
          .map(el => {
            const s = sel(el);
            return {
              selector: s,
              matchIndex: matchIndex(el, s),
              value: el.value || el.textContent?.trim() || '',
              label: el.getAttribute('aria-label') || el.placeholder || el.name || el.id || '',
              type: el.type || el.tagName.toLowerCase(),
            };
          })
          .filter(f => f.value && f.value.length >= 3 && f.value.length < 300);
        }).catch(() => []);

        const settling = Date.now() - lastNavAt < 1800;
        for (const f of fields) {
          const key = f.selector + '|' + f.matchIndex;
          if (lastFieldVals.get(key) === f.value) continue;
          lastFieldVals.set(key, f.value);
          if (settling) continue; // widget still loading its default (e.g. price-range slider) — not a user edit
          // Remove any previous fill for same selector+index (keep latest value only)
          const existing = sess.steps.findIndex(s => s.type === 'fill' && s.selector === f.selector && (s.matchIndex || 0) === f.matchIndex);
          if (existing !== -1) sess.steps.splice(existing, 1);
          sess.steps.push({ type: 'fill', selector: f.selector, matchIndex: f.matchIndex, value: f.value, label: f.label, inputType: f.type, autocomplete: true, timestamp: Date.now() });
        }
      } catch (_) {}
    }, 600);

    res.json({ success: true, sessionId });
  } catch (err) {
    res.status(500).json({ error: 'Could not start recording: ' + err.message });
  }
});

// Post-recording cleanup — MUST run on every path that hands steps to the review UI.
// (There are two stop paths: the in-browser "⏹ Stop & Save" toolbar button, whose steps flow
// through GET /status polling, and the in-app stop button, which POSTs /stop.)
function cleanRecordedSteps(steps) {
  // Step 1: Remove duplicate rapid clicks
  let clean = steps.filter((step, i) => {
    if (i === 0) return true;
    const prev = steps[i - 1];
    if (step.type === 'click' && prev.type === 'click' && step.selector === prev.selector && step.timestamp - prev.timestamp < 400) return false;
    return true;
  });

  // Step 2: Strip Google preamble — find the first real (non-Google) navigate and start there
  const firstRealNav = clean.findIndex(s =>
    s.type === 'navigate' &&
    !s.url.includes('google.com') &&
    !s.url.includes('google.co') &&
    !s.url.startsWith('about:') &&
    !s.url.startsWith('chrome:')
  );
  if (firstRealNav > 0) clean = clean.slice(firstRealNav);

  // Step 3: Deduplicate consecutive navigates to the same URL
  clean = clean.filter((step, i) => {
    if (step.type !== 'navigate') return true;
    const prev = clean.slice(0, i).reverse().find(s => s.type === 'navigate');
    return !prev || prev.url !== step.url;
  });

  // Step 4: For fills and sliders on the same field (selector + matchIndex), keep only the LAST one —
  // repeated snapshots/drag adjustments produce many intermediate values; only the final value matters.
  const lastPos = new Map();
  clean.forEach((s, i) => {
    if (s.type === 'fill' || s.type === 'slider') lastPos.set(s.type + '|' + s.selector + '|' + (s.matchIndex || 0), i);
  });
  clean = clean.filter((s, i) =>
    (s.type !== 'fill' && s.type !== 'slider') || lastPos.get(s.type + '|' + s.selector + '|' + (s.matchIndex || 0)) === i
  );

  // Step 4b: Same idea for stepper clicks (e.g. clicking "+" three times on a passenger count) —
  // each click records its own running total, but only the FINAL one reflects what was actually
  // wanted; keep just the last stepper step per row (identified by its count-display element,
  // since stepper steps have no single [selector] the way fill/slider do).
  const lastStepperPos = new Map();
  clean.forEach((s, i) => {
    if (s.type === 'stepper') lastStepperPos.set(s.countSelector + '|' + (s.countMatchIndex || 0), i);
  });
  clean = clean.filter((s, i) =>
    s.type !== 'stepper' || lastStepperPos.get(s.countSelector + '|' + (s.countMatchIndex || 0)) === i
  );

  // Step 5: Drop repeat navigates to a page path already visited (query string ignored). Many
  // sites (Daraz among them) fire a second, harmless "soft" navigate shortly after a product page
  // loads — tracking params or slug normalization, not a real page change. If kept, it survives as
  // a hardcoded page.goto() that permanently overrides wherever a later run's search actually leads,
  // since it isn't directly preceded by the click that reaches the product (something else — often
  // a small icon/stepper click — sits in between), so the "trust the click's live navigation" replay
  // safeguard doesn't catch it. Keeping only the FIRST visit to a path removes the duplicate outright.
  const seenPaths = new Set();
  clean = clean.filter(s => {
    if (s.type !== 'navigate') return true;
    let pathKey;
    try { const u = new URL(s.url); pathKey = u.hostname + u.pathname; } catch { pathKey = s.url; }
    if (seenPaths.has(pathKey)) return false;
    seenPaths.add(pathKey);
    return true;
  });

  // Step 6: Drop a generic 'click' immediately followed by a 'choice' selecting the SAME label.
  // This happens when a click lands on a label/text element that sits next to — but isn't inside
  // — the actual interactive control (e.g. Google Forms' custom radio buttons render their text
  // as a sibling div, not a descendant), so the click is recorded twice: once as an unrecognized
  // generic click, then again correctly as a choice selection. Replaying both double-clicks the
  // option — several accessible radio/checkbox widgets treat a second click on an
  // already-selected option as a toggle-OFF, so replay would select it and then immediately
  // deselect it, submitting nothing.
  clean = clean.filter((s, i) => {
    if (s.type !== 'click') return true;
    const next = clean[i + 1];
    return !(next && next.type === 'choice' && next.selectedLabel === s.label);
  });

  // Step 7: An 'autocomplete' step (typeahead suggestion pick) covers the SAME field the generic
  // fill-snapshot mechanism also watches (role="combobox" stays in the fill selector so a plain
  // typed-and-blurred combobox with no suggestion click still gets captured) — where an
  // autocomplete step exists for a selector+matchIndex, its re-type-and-pick-live-suggestion
  // replay supersedes a plain fill, so drop the redundant fill to avoid double-typing the field.
  const autoKeys = new Set(clean.filter(s => s.type === 'autocomplete').map(s => s.selector + '|' + (s.matchIndex || 0)));
  clean = clean.filter(s => !(s.type === 'fill' && autoKeys.has(s.selector + '|' + (s.matchIndex || 0))));

  // Step 8: Collapse a run of consecutive 'date' steps into just the last one — a user commonly
  // clicks around a calendar (browsing months, correcting a misclick) before landing on the date
  // they actually want, and only the final pick reflects that. Non-consecutive date steps
  // (separated by some other action — e.g. genuinely picking both a departure AND a return date)
  // are left alone since those are two different fields.
  clean = clean.filter((s, i) => {
    if (s.type !== 'date') return true;
    const next = clean[i + 1];
    return !(next && next.type === 'date');
  });

  // Step 9: Drop a 'choice' step immediately followed by another 'choice' selecting the IDENTICAL
  // option in the SAME group. Some sites' widgets fire the underlying selection handler twice for
  // one physical click (a re-render plus a confirm event), recording the same pick twice in a row
  // — harmless to replay once, but confusing as two separate near-duplicate variables.
  clean = clean.filter((s, i) => {
    if (s.type !== 'choice') return true;
    const next = clean[i + 1];
    return !(next && next.type === 'choice' && next.label === s.label && next.selectedLabel === s.selectedLabel);
  });

  return clean;
}

app.get('/api/recording/status/:sessionId', requireAuth, (req, res) => {
  const s = activeSessions.get(req.params.sessionId);
  if (!s) return res.json({ active: false, stopped: true, steps: [] });
  if (s.stopped) {
    const steps = cleanRecordedSteps(s.steps || []);
    activeSessions.delete(req.params.sessionId);
    return res.json({ active: false, stopped: true, steps });
  }
  res.json({ active: true, stopped: false, stepCount: s.steps.length });
});

app.post('/api/recording/stop/:sessionId', requireAuth, async (req, res) => {
  const s = activeSessions.get(req.params.sessionId);
  if (!s) return res.status(404).json({ error: 'Session not found.' });

  const steps = s.steps || [];
  // Capture cookies from the recording session (helps bypass bot detection on replay)
  let sessionCookies = [];
  try {
    const pages = await s.browser?.pages();
    if (pages?.length) sessionCookies = await pages[0].cookies().catch(() => []);
  } catch (_) {}
  try { await s.browser?.close(); } catch (_) {}
  activeSessions.delete(req.params.sessionId);
  logUsage(req.user.id, 'record');

  res.json({ success: true, steps: cleanRecordedSteps(steps), cookies: sessionCookies });
});

// ─── EXTENSION RECORDING IMPORT ───────────────────────────────────────────────
// The Chrome extension records in the USER'S browser (works from anywhere) and
// uploads steps here; the web app's Record page then offers them for review.
app.post('/api/recording/import', requireAuth, (req, res) => {
  const steps = Array.isArray(req.body.steps) ? req.body.steps : [];
  const cookies = Array.isArray(req.body.cookies) ? req.body.cookies : [];
  if (!steps.length) return res.status(400).json({ error: 'No steps provided.' });
  const clean = cleanRecordedSteps(steps);
  db.prepare(`INSERT INTO pending_recordings (user_id, steps, cookies, created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(user_id) DO UPDATE SET steps=excluded.steps, cookies=excluded.cookies, created_at=CURRENT_TIMESTAMP`)
    .run(req.user.id, JSON.stringify(clean), encryptCookies(cookies));
  logUsage(req.user.id, 'record');
  res.json({ success: true, stepCount: clean.length });
});

app.get('/api/recording/pending', requireAuth, (req, res) => {
  const row = db.prepare('SELECT steps, cookies, created_at FROM pending_recordings WHERE user_id=?').get(req.user.id);
  res.json(row ? { steps: JSON.parse(row.steps), cookies: decryptCookiesField(row.cookies), created_at: row.created_at } : { steps: null });
});

app.delete('/api/recording/pending', requireAuth, (req, res) => {
  db.prepare('DELETE FROM pending_recordings WHERE user_id=?').run(req.user.id);
  res.json({ success: true });
});

// ─── WORKFLOW ROUTES ──────────────────────────────────────────────────────────
// A step marked as a per-user credential field is never replayed with its own recorded value
// (replay always looks the running user's own login up from site_credentials) — so the literal
// password/email the creator typed while recording it is never needed again. Strip it wherever
// steps are written OR read, so it can't linger in the database or leak to anyone who fetches
// the workflow (e.g. a marketplace buyer via /api/my-purchased).
function scrubCredentialSteps(steps) {
  return (steps || []).map(s =>
    (s.variableName === '__credential_password' || s.variableName === '__credential_email')
      ? { ...s, value: '' }
      : s
  );
}
const parseWf = (w) => {
  if (!w) return null;
  const { session_cookies, ...rest } = w; // never sent to any client — server-replay-only, and encrypted at rest regardless
  return {
    ...rest,
    steps:     scrubCredentialSteps(JSON.parse(w.steps || '[]')),
    variables: JSON.parse(w.variables || '[]'),
    constants: JSON.parse(w.constants || '{}'),
  };
};

app.get('/api/workflows', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM workflows WHERE user_id=? ORDER BY created_at DESC').all(req.user.id).map(parseWf));
});

app.post('/api/workflows', requireAuth, (req, res) => {
  const { name, description, url, steps, variables, constants, cookies, authMode, loginDomain } = req.body;
  if (!name) return res.status(400).json({ error: 'API name is required.' });
  const cleanSteps = scrubCredentialSteps(steps);
  const id = uuidv4();
  db.prepare('INSERT INTO workflows (id,user_id,name,description,url,steps,variables,constants,session_cookies,auth_mode,login_domain) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, req.user.id, name, description || '', url || '', JSON.stringify(cleanSteps), JSON.stringify(variables || []), JSON.stringify(constants || {}), encryptCookies(cookies), authMode === 'per_user' ? 'per_user' : 'shared', loginDomain || '');
  res.json({ success: true, workflow: parseWf(db.prepare('SELECT * FROM workflows WHERE id=?').get(id)) });
});

app.get('/api/workflows/:id', requireAuth, (req, res) => {
  const w = db.prepare('SELECT * FROM workflows WHERE id=?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found.' });
  const isOwner = w.user_id === req.user.id;
  const bought  = db.prepare('SELECT id FROM purchases WHERE buyer_id=? AND workflow_id=?').get(req.user.id, req.params.id);
  if (!isOwner && !bought) return res.status(403).json({ error: 'You do not have access to this API.' });
  res.json(parseWf(w));
});

app.put('/api/workflows/:id', requireAuth, (req, res) => {
  const w = db.prepare('SELECT * FROM workflows WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!w) return res.status(404).json({ error: 'Not found.' });
  const { name, description, is_public, price, price_description, variables, constants, renameVariables, updateConstants } = req.body;

  // Only touch variables/constants/steps if the request actually provided something for them —
  // this endpoint is also used for simple metadata edits (name, price, publish toggle) that don't
  // send these fields at all, and treating "not sent" as "clear it" would silently wipe them out.
  const oldVariables = JSON.parse(w.variables || '[]');
  let newVariables = variables !== undefined ? variables : oldVariables;
  let newConstants  = constants !== undefined ? constants : JSON.parse(w.constants || '{}');
  let newSteps      = JSON.parse(w.steps || '[]');

  if (Array.isArray(renameVariables)) {
    // Positional, not name-keyed — recordings can produce duplicate variable names (e.g. two
    // fields both literally "input"), which name-based matching couldn't tell apart. Regular
    // field variables and action-gated button variables are appended to the variables array in
    // two separate passes when a workflow is first saved (see saveWorkflow in index.html), so we
    // replay that same two-pool order here to match each array entry back to its recorded step.
    const fieldStepIdx  = newSteps.map((s, i) => i).filter(i => newSteps[i].isVariable && newSteps[i].variableName !== undefined && !newSteps[i].isOptionalAction);
    const actionStepIdx = newSteps.map((s, i) => i).filter(i => newSteps[i].isOptionalAction && newSteps[i].actionName !== undefined);
    let fieldPtr = 0, actionPtr = 0;
    newVariables = oldVariables.map(v => ({ ...v }));
    oldVariables.forEach((v, i) => {
      const isAction = v.type === 'action';
      const stepIdx = isAction ? actionStepIdx[actionPtr++] : fieldStepIdx[fieldPtr++];
      const newName = renameVariables[i];
      if (!newName || newName === v.name) return;
      if (stepIdx !== undefined) {
        newSteps[stepIdx] = isAction
          ? { ...newSteps[stepIdx], actionName: newName }
          : { ...newSteps[stepIdx], variableName: newName };
      }
      newVariables[i] = { ...newVariables[i], name: newName, label: newName };
    });
  }

  if (updateConstants && Array.isArray(updateConstants.labels)) {
    // Same positional matching as variable renames, but what actually matters for a constant is
    // its VALUE — replay for a constant field just reuses step.value directly (the "constants"
    // object itself isn't consulted for fill replay), so fixing the label alone wouldn't change
    // behavior. This updates both: the label for the user's own reference, and step.value for
    // the field it's genuinely typed into. Only plain 'fill' steps are value-editable this way;
    // a choice/slider/toggle marked constant keeps its recorded selection, only its label renames.
    const { labels, values } = updateConstants;
    const oldConstEntries = Object.entries(JSON.parse(w.constants || '{}'));
    const constStepIdx = newSteps.map((s, i) => i).filter(i =>
      ['fill', 'choice', 'slider', 'toggle', 'autocomplete', 'date', 'stepper'].includes(newSteps[i].type) && newSteps[i].isVariable === false
    );
    const rebuilt = {};
    oldConstEntries.forEach(([oldKey, oldVal], i) => {
      const newLabel = labels[i] || oldKey;
      const newValue = values[i] !== undefined ? values[i] : oldVal;
      rebuilt[newLabel] = newValue;
      const stepIdx = constStepIdx[i];
      if (stepIdx !== undefined && ['fill', 'autocomplete', 'date', 'stepper'].includes(newSteps[stepIdx].type)) {
        newSteps[stepIdx] = { ...newSteps[stepIdx], value: newValue };
      }
    });
    newConstants = rebuilt;
  }

  db.prepare('UPDATE workflows SET name=?,description=?,is_public=?,price=?,price_description=?,variables=?,constants=?,steps=? WHERE id=?')
    .run(name || w.name, description ?? w.description, is_public ? 1 : 0, price ?? 0, price_description ?? '', JSON.stringify(newVariables), JSON.stringify(newConstants), JSON.stringify(scrubCredentialSteps(newSteps)), w.id);
  res.json({ success: true });
});

app.delete('/api/workflows/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM workflows WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

// For 'per_user' auth workflows, each running user must have saved their OWN login for the
// site (Settings → Saved Site Logins) — we never fall back to the creator's session for these.
// Returns { credentialInputs } on success, or throws a user-facing error message.
function resolvePerUserLogin(w, userId) {
  if (w.auth_mode !== 'per_user') return null;
  const row = db.prepare('SELECT email, password_enc FROM site_credentials WHERE user_id=? AND domain=?').get(userId, w.login_domain);
  if (!row) throw new Error(`This API needs your own login for ${w.login_domain || 'this site'}. Save it once in Settings → Saved Site Logins, then try again.`);
  return { __credential_email: row.email, __credential_password: decryptSecret(row.password_enc) };
}

app.post('/api/workflows/:id/call', requireAuth, checkUsageLimit, async (req, res) => {
  const w = db.prepare('SELECT * FROM workflows WHERE id=?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'API not found.' });

  const isOwner = w.user_id === req.user.id;
  const bought  = db.prepare('SELECT id FROM purchases WHERE buyer_id=? AND workflow_id=?').get(req.user.id, req.params.id);
  if (!isOwner && !bought && w.price > 0) return res.status(403).json({ error: 'Purchase this API first.' });
  if (req.user.plan === 'free') return res.status(403).json({ error: 'Calling APIs requires a paid plan. Please upgrade.', upgradeRequired: true });

  let credentialInputs;
  try { credentialInputs = resolvePerUserLogin(w, req.user.id); }
  catch (err) { return res.status(400).json({ error: err.message, needsLogin: true, loginDomain: w.login_domain }); }

  logUsage(req.user.id, 'call', w.id);
  db.prepare('UPDATE workflows SET call_count=call_count+1, last_run=CURRENT_TIMESTAMP WHERE id=?').run(w.id);

  const steps      = JSON.parse(w.steps     || '[]');
  const constants   = JSON.parse(w.constants || '{}');
  const inputs      = { ...constants, ...(req.body.inputs || {}), ...(credentialInputs || {}) };
  const savedCookies = credentialInputs ? [] : decryptCookiesField(w.session_cookies);

  try {
    const result = await replayWorkflow(steps, inputs, savedCookies);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: 'Execution failed: ' + err.message });
  }
});

async function replayWorkflow(steps, inputs, savedCookies = [], onProgress) {
  const fsp = require('fs');
  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const executablePath = chromePaths.find(p => fsp.existsSync(p));

  // HEADLESS=1 (cloud deployment: no display on the server). Default stays headful
  // locally — a visible browser evades bot detection better and demos well.
  const browser = await puppeteer.launch({
    headless: process.env.HEADLESS === '1' ? 'new' : false,
    executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--window-size=1280,800', '--window-position=50,50'],
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
  await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator,'webdriver',{get:()=>undefined}); });

  // Block images/fonts/media (keep stylesheets — some sites need them)
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['image','font','media'].includes(req.resourceType())) req.abort();
    else req.continue();
  });

  // Global 90-second replay timeout — prevents 5-minute hangs on bad recordings
  const replayTimeout = setTimeout(async () => {
    try { await browser.close(); } catch (_) {}
  }, 90000);

  // Helper: detect if the current page is a bot-block / CAPTCHA page
  const isBotBlocked = async () => {
    try {
      return await page.evaluate(() => {
        const url   = window.location.href;
        const title = document.title.toLowerCase();

        // Google's CAPTCHA / unusual-traffic page
        if (url.includes('google.com/sorry')) return true;

        // Cloudflare challenge pages — their TITLE is exactly these phrases
        if (title === 'just a moment...' || title === 'attention required! | cloudflare') return true;
        if (title.startsWith('checking your browser')) return true;

        // Cloudflare ray-id footer is a very specific signature
        const rayId = document.querySelector('#cf-error-details, .ray-id, #cf-content');
        if (rayId) return true;

        // Cloudflare challenge form
        if (document.querySelector('#challenge-form, #challenge-running, #turnstile-wrapper')) return true;

        return false;
      });
    } catch { return false; }
  };

  // Resolve a step's target element, honoring matchIndex when the selector matches several elements
  // (e.g. min & max salary boxes both recorded as "input.border").
  const pickEl = async (step) => {
    const els = await page.$$(step.selector).catch(() => []);
    if (!els.length) return null;
    return els[Math.min(step.matchIndex || 0, els.length - 1)];
  };

  try {
    // Inject saved session cookies if any (helps bypass bot detection on repeat runs)
    if (savedCookies.length) {
      onProgress?.('Restoring session...');
      await page.setCookie(...savedCookies).catch(() => {});
    }

    // Safety net: skip any steps before the first non-Google navigate
    const isGoogleUrl = u => u && (u.includes('google.com') || u.includes('google.co'));
    const firstReal = steps.findIndex(s => s.type === 'navigate' && !isGoogleUrl(s.url));
    const stepsToRun = firstReal > 0 ? steps.slice(firstReal) : steps;

    // Recorded variable values, so a navigate URL that baked in the original search term
    // (e.g. ?query=ek+nojo) can be rewritten with the value the user actually asked for this run.
    const recordedVarValues = {};
    for (const s of stepsToRun) {
      if (['fill', 'autocomplete', 'date', 'stepper'].includes(s.type) && s.isVariable && s.variableName && s.value !== undefined) recordedVarValues[s.variableName] = s.value;
    }

    // Visible replay confidence: a step whose target can't be found on THIS run (site layout
    // shifted, a requested value has no matching option, etc.) used to fail silently — the run
    // would just quietly skip it and report success anyway, leaving no way for anyone (including
    // the end user, who can't inspect server logs) to know a field didn't actually get set. Every
    // step handler below now records a warning here instead when its target can't be resolved, and
    // the chat response surfaces them plainly rather than pretending everything worked.
    const warnings = [];

    // Set right after a click that itself caused a real navigation (e.g. clicking a search-result
    // card, or a search button that submits a form). The NEXT recorded step is very often the
    // 'navigate' that click produced during recording — but replaying it as a literal page.goto()
    // to that exact recorded URL would override wherever the live click just correctly went (e.g.
    // forcing every run back to the ONE product that happened to be recorded, regardless of the
    // search term this run actually used). Trust the click's real navigation instead.
    let skipNextNavigate = false;

    for (let stepIdx = 0; stepIdx < stepsToRun.length; stepIdx++) {
      const step = stepsToRun[stepIdx];
      const nextStep = stepsToRun[stepIdx + 1];
      const shouldSkipThisNavigate = step.type === 'navigate' && skipNextNavigate;
      skipNextNavigate = false;
      if (step.type === 'navigate') {
        if (shouldSkipThisNavigate) continue;
        // Rewrite recorded variable values ONLY inside the query string (?q=colgate → ?q=lifebuoy).
        // The path must never be touched: product slugs like /products/colgate-maxfresh-...
        // encode a specific page, and rewriting them fabricates URLs that 404.
        //
        // This operates on REAL, decoded query parameters (via URL/searchParams) and replaces a
        // param's WHOLE value — never a raw substring splice across the query string. A splice-based
        // approach breaks the moment the recorded fill snapshot doesn't exactly match what actually
        // ended up in the URL (e.g. recorded value "dove" when the real search was "dove soap" —
        // autocomplete completed it, or the snapshot fired before typing finished): splicing only
        // "dove" leaves the stray "soap" glued onto the new term, producing a broken hybrid query.
        // Matching by prefix and replacing the full param value avoids that class of corruption.
        let url = step.url;
        // Google Forms/Docs render their UI in the viewer's account/locale language — a form
        // recorded while the UI showed English replays with a Bengali (or other) "Submit" button,
        // so the recorded English label no longer matches and the submit click falls back to a
        // fragile positional index. Force hl=en so recorded labels stay valid under any account.
        if (/docs\.google\.com\/forms/.test(url) && !/[?&]hl=/.test(url)) {
          url += (url.includes('?') ? '&' : '?') + 'hl=en';
        }
        if (url.includes('?')) {
          try {
            const u = new URL(url);
            for (const [varName, recordedVal] of Object.entries(recordedVarValues)) {
              const newVal = inputs[varName];
              if (newVal === undefined || String(newVal) === recordedVal || !recordedVal) continue;
              for (const [key, val] of [...u.searchParams.entries()]) {
                if (val.startsWith(recordedVal) || recordedVal.startsWith(val)) u.searchParams.set(key, String(newVal));
              }
            }
            url = u.toString();
          } catch (_) {}
        }
        // urlParams: choice variables that drive a query parameter (e.g. sort order).
        // Shape: { sort: { variable: 'Sort', map: { 'Price Low To High': 'priceasc', ... } } }
        // The AI outputs a human label; we map it to the site's URL token. Empty token = remove param.
        if (step.urlParams) {
          try {
            const u = new URL(url);
            const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            for (const [param, spec] of Object.entries(step.urlParams)) {
              const want = inputs[spec.variable];
              if (want === undefined) continue;
              let mapped = null;
              for (const [label, val] of Object.entries(spec.map || {})) {
                if (norm(label) === norm(want) || norm(label).includes(norm(want)) || norm(want).includes(norm(label))) { mapped = val; break; }
              }
              if (mapped === null) continue;
              if (mapped === '') u.searchParams.delete(param);
              else u.searchParams.set(param, mapped);
            }
            url = u.toString();
          } catch (_) {}
        }
        const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();
        onProgress?.(`Opening ${host}...`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 1500));
        if (await isBotBlocked()) throw new Error('BOT_BLOCKED:' + url);
      } else if (step.type === 'click') {
        // Optional actions (Add to Cart, Buy Now, Apply...) run only when the user asked for them.
        if (step.isOptionalAction) {
          const want = String(inputs[step.actionName] ?? 'no').trim();
          if (!/^(y|yes|true|1|do|ok|confirm)/i.test(want)) continue;
        }
        const label = step.label || step.selector.replace(/[#.[\]"'=]/g,' ').trim().slice(0,30);
        onProgress?.(`Clicking "${label}"...`);
        // An icon-only submit control (empty/tag-name label) followed by a recorded navigate is a
        // submit whose recorded selector+matchIndex can't be trusted (a generic class, positional
        // index that shifts). Skip the blind matchIndex click — which could hit the WRONG button
        // and navigate somewhere bad — and let the submit-button rescue below find the real one.
        const unhelpfulLabel = !step.label || step.label === step.tag || /^(button|a|span|div)$/i.test(step.label);
        const iconLeaf = /^(path|svg|use|i)$/i.test(step.selector);
        // A recorded click whose LABEL reads like a submit action but was captured on an inner
        // text/leaf element (e.g. Google Forms' Submit is a <span> inside the real role=button, so
        // clicking the span alone often doesn't fire the button's handler). We still let the normal
        // click try first, but if it produces no navigation we run the submit rescue to click the
        // actual button. Kept separate from submitShaped so it does NOT skip the primary click.
        const submitLikeLabel = nextStep && nextStep.type === 'navigate' &&
          /^(submit|search|continue|go|apply|find|next|book|proceed|done|order|buy)$/i.test((step.label || '').trim());
        const submitShaped = iconLeaf || (unhelpfulLabel && nextStep && nextStep.type === 'navigate');
        await page.waitForSelector(step.selector, { timeout: 3000 }).catch(() => {});
        const urlBeforeClick = page.url();
        // Selectors built from a shared class (common for tab/filter/accordion headers styled
        // identically) can match several elements — disambiguate by the text captured at record
        // time, falling back to the recorded matchIndex position.
        let disambiguated = false;
        let labelMatched = false;
        if (!submitShaped) try {
          const matches = await page.$$(step.selector);
          if (matches.length > 1) {
            let target = null;
            if (step.label) {
              const norm = s => s.toLowerCase().replace(/\s+/g, ' ').trim();
              const wantNorm = norm(step.label);
              // Exact trim match first, then a normalised (case/whitespace-insensitive) exact
              // match, then substring containment — "Add to Cart" should still match a button
              // whose text came out as "🛒 Add to Cart" or with stray whitespace from markup.
              for (const m of matches) {
                const text = await m.evaluate(e => e.textContent.trim()).catch(() => '');
                if (text === step.label) { target = m; labelMatched = true; break; }
              }
              if (!target) {
                for (const m of matches) {
                  const text = await m.evaluate(e => e.textContent.trim()).catch(() => '');
                  const textNorm = norm(text);
                  if (textNorm === wantNorm || (wantNorm && textNorm.includes(wantNorm))) { target = m; labelMatched = true; break; }
                }
              }
            }
            if (!target && step.matchIndex !== undefined) target = matches[Math.min(step.matchIndex, matches.length - 1)];
            if (target) { await target.scrollIntoView().catch(() => {}); await target.click().catch(() => {}); disambiguated = true; }
          }
        } catch (_) {}
        if (!disambiguated && !submitShaped) await page.click(step.selector).catch(() => {});
        await Promise.race([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 4000 }).catch(() => {}),
          new Promise(r => setTimeout(r, 250)),
        ]);
        skipNextNavigate = page.url() !== urlBeforeClick;

        // Submit/search-button rescue. A search/submit control is frequently an icon-only button
        // (or was recorded as the bare <svg>/<path> icon inside it) with NO stable identity — a
        // generic class + positional matchIndex that can't be re-found at replay. When that click
        // misses, the run falls back to the recorded navigate URL, which still encodes the ORIGINAL
        // recorded search, throwing away every field we just filled (this is why ShareTrip kept
        // reverting to its recorded default flight). `submitShaped` (computed above) already
        // identified this shape and made us skip the untrustworthy primary click; now find and
        // click the real submit button so the SITE rebuilds the URL from the fields we set.
        if (!skipNextNavigate && (submitShaped || submitLikeLabel)) {
          const before = page.url();
          const wantLabel = (step.label || '').trim();
          const btn = await page.evaluateHandle((wantLabel) => {
            const vis = e => e && e.offsetHeight > 0 && e.offsetWidth > 0;
            const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            // 0) If we have a submit-like label, prefer the visible button/role=button whose own
            //    text matches it exactly (Google Forms "Submit" role=button, etc.).
            if (wantLabel) {
              const w = norm(wantLabel);
              const exact = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
                .filter(vis).find(e => norm(e.textContent) === w || norm(e.getAttribute('aria-label')) === w);
              if (exact) return exact;
            }
            // 1) Explicit submit control.
            let el = document.querySelector('button[type="submit"], input[type="submit"]');
            if (vis(el)) return el;
            // 2) A BUTTON (not <a> — promo links falsely match "search") whose OWN short label or
            //    aria-label reads like a submit action.
            const re = /^(search|find|submit|go|apply|search flights?|show results?|explore)\b/i;
            const btns = Array.from(document.querySelectorAll('button, [role="button"]')).filter(vis);
            const byText = btns.find(e => {
              const t = (e.textContent || '').trim();
              const a = (e.getAttribute('aria-label') || '').trim();
              return (t.length <= 20 && re.test(t)) || re.test(a);
            });
            if (byText) return byText;
            // 3) Icon-only submit: a prominent COLORED icon button (svg, no text, saturated
            //    non-transparent background), excluding utility icons (clear/close/menu/etc).
            //    Search/submit buttons are near-universally the one visually-emphasized colored
            //    button in a form; utility icon buttons are transparent/grey.
            const util = /clear|close|remove|menu|back|prev|next|delete|cancel|edit/i;
            const colored = btns.filter(b => {
              if ((b.textContent || '').trim() || !b.querySelector('svg')) return false;
              if (util.test(b.getAttribute('aria-label') || '')) return false;
              const m = getComputedStyle(b).backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
              if (!m) return false;
              const [r, g, bl, al] = [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
              if (al < 0.5) return false;
              return (Math.max(r, g, bl) - Math.min(r, g, bl)) > 40 && Math.max(r, g, bl) > 80;
            });
            return colored.length ? colored[colored.length - 1] : null;
          }, wantLabel).catch(() => null);
          const el = btn?.asElement() || null;
          if (el) {
            await el.scrollIntoView().catch(() => {});
            await el.click().catch(() => {});
            await Promise.race([
              page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {}),
              new Promise(r => setTimeout(r, 400)),
            ]);
            skipNextNavigate = page.url() !== before;
          }
        }

        // Positional image-click fallback — ONLY for the "click into a product thumbnail" shape:
        // a bare <img> with no meaningful recorded label (label fell back to the tag name itself,
        // meaning the image had no alt/aria-label at record time). This must NOT fire for labeled
        // action buttons (Add to Cart, Buy Now...) just because they didn't navigate — most of
        // those succeed by updating the page via AJAX, never navigating at all, so "no navigation"
        // is the expected good outcome there, not a signal that the click failed.
        if (!skipNextNavigate && !labelMatched && step.selector === 'img' && step.label === 'img') {
          const handle = await page.evaluateHandle(() => {
            const imgs = Array.from(document.querySelectorAll('img[alt]')).filter(i => {
              const alt = (i.alt || '').trim();
              if (alt.length <= 8 || /logo/i.test(alt)) return false;
              const link = i.closest('a[href]');
              if (!link) return false;
              try { const u = new URL(link.href, location.href); if (u.pathname === '/' || u.pathname === '') return false; } catch (_) { return false; }
              return true;
            });
            return imgs[0] || null;
          }).catch(() => null);
          const el = handle?.asElement();
          if (el) {
            await el.scrollIntoView().catch(() => {});
            await el.click().catch(() => {});
            await Promise.race([
              page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 4000 }).catch(() => {}),
              new Promise(r => setTimeout(r, 250)),
            ]);
            skipNextNavigate = page.url() !== urlBeforeClick;
          }
        }
      } else if (step.type === 'fill') {
        let value = step.value;
        if (step.isVariable && step.variableName) {
          // Exact match first
          if (inputs[step.variableName] !== undefined) {
            value = inputs[step.variableName];
          } else {
            // Fuzzy match: compare normalised variable name and label against input keys
            const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
            const vn = norm(step.variableName);
            const vl = norm(step.label || '');
            for (const [key, val] of Object.entries(inputs)) {
              const kn = norm(key);
              if (kn === vn || kn === vl || vn.includes(kn) || kn.includes(vn) || vl.includes(kn) || kn.includes(vl)) {
                value = val; break;
              }
            }
          }
        }
        const label = step.label || step.variableName || 'field';
        onProgress?.(`Filling "${label}"...`);
        await page.waitForSelector(step.selector, { timeout: 3000 }).catch(() => {});
        const fillEl = await pickEl(step);
        if (fillEl) {
          if (step.autocomplete) {
            // Search/typeahead fields (airport/location pickers) are stateful widgets, not plain
            // inputs — clearing them via JS (el.value='') corrupts the widget's internal state so
            // the suggestion you later click never actually COMMITS (the visible text updates but
            // the real selected value stays the OLD one, and the form submits the stale selection).
            // Drive it exactly like a human: focus, select-all with the keyboard, then TYPE with
            // real key events so the widget treats it as a genuine edit and opens its dropdown.
            await fillEl.click().catch(() => {});
            await new Promise(r => setTimeout(r, 250));
            await page.keyboard.down('Control').catch(() => {});
            await page.keyboard.press('KeyA').catch(() => {});
            await page.keyboard.up('Control').catch(() => {});
            await page.keyboard.type(String(value), { delay: 80 }).catch(() => {});
          } else {
            await fillEl.click({ clickCount: 3 }).catch(() => {});
            await fillEl.evaluate(el => {
              if (el.value !== undefined) el.value = '';
              else el.textContent = '';
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }).catch(() => {});
            await fillEl.type(String(value), { delay: 50 }).catch(() => {});
          }
        } else {
          warnings.push(`Couldn't find the "${label}" field on this run — it may not have been typed in.`);
        }
        await new Promise(r => setTimeout(r, 700));
        // `autocomplete:true` is set on EVERY recorded fill (it just marks a snapshot-captured
        // value), so most of these are ordinary text fields (Google Forms, plain inputs) with NO
        // suggestion dropdown — typing alone is the whole job there. Only a TRUE typeahead field
        // (airport/location/product search) shows a [role=option] dropdown, and for those the
        // selection must be committed by clicking a suggestion or the form submits the stale prior
        // value. So: look for a dropdown; pick from it if present; if none appears, it's a plain
        // field — do nothing and DON'T warn (a "no suggestion" warning on every text field is just
        // noise and looks broken).
        if (step.autocomplete && fillEl) {
          let picked = false, dropdownSeen = false;
          for (let attempt = 0; attempt < 3 && !picked; attempt++) {
            await new Promise(r => setTimeout(r, attempt ? 500 : 350));
            const optCount = await page.$$eval('[role="option"], [role="listbox"] li, .pac-container .pac-item',
              els => els.filter(o => o.offsetHeight > 0).length).catch(() => 0);
            if (!optCount) continue; // no dropdown yet (or plain field)
            dropdownSeen = true;
            const handle = await page.evaluateHandle((wanted) => {
              const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
              const opts = Array.from(document.querySelectorAll('[role="option"], [role="listbox"] li, .pac-container .pac-item'))
                .filter(o => o.offsetHeight > 0);
              if (!opts.length) return null;
              const w = norm(wanted);
              return opts.find(o => w && norm(o.textContent).includes(w)) || opts[0];
            }, String(value)).catch(() => null);
            const optEl = handle?.asElement() || null;
            if (optEl) {
              await optEl.scrollIntoView().catch(() => {});
              await optEl.click().catch(() => {});
              picked = true;
            }
          }
          // Only a genuine typeahead (a dropdown DID appear) that we then failed to commit is worth
          // flagging. A field that never showed a dropdown is just a normal text input — no warning.
          if (dropdownSeen && !picked) {
            await page.keyboard.press('ArrowDown').catch(() => {});
            await new Promise(r => setTimeout(r, 250));
            await page.keyboard.press('Enter').catch(() => {});
          }
          await new Promise(r => setTimeout(r, 500));
        }
      } else if (step.type === 'choice') {
        // Pick whichever recorded option's label best matches the requested value —
        // falls back to the originally-recorded selection if not a variable or no good match.
        let selector = step.selectedSelector, targetLabel = step.selectedLabel;
        if (step.isVariable && step.variableName && inputs[step.variableName] !== undefined) {
          const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          const wanted = norm(inputs[step.variableName]);
          let best = null, bestScore = 0;
          for (const opt of step.options || []) {
            const optNorm = norm(opt.label);
            const score = optNorm === wanted ? 2 : (optNorm.includes(wanted) || wanted.includes(optNorm)) ? 1 : 0;
            if (score > bestScore) { bestScore = score; best = opt; }
          }
          if (best) { selector = best.selector; targetLabel = best.label; }
          else warnings.push(`Requested "${inputs[step.variableName]}" for "${step.label || 'a choice field'}" didn't match any recorded option (${(step.options||[]).map(o=>o.label).join(', ')}) — kept the originally recorded selection instead.`);
        }
        onProgress?.(`Selecting "${targetLabel}"...`);
        if (step.mode === 'text') {
          // No real form element behind this option — find whatever's currently on screen with this
          // exact visible text (the filter panel this belongs to was opened by an earlier recorded
          // click step). App-framework UIs (Angular/React) often ignore synthetic el.click() calls —
          // only a real, trusted Puppeteer click (auto-scrolled into view) actually registers.
          // Retry for up to ~4s: the panel a preceding click opened may still be animating in.
          let el = null;
          for (let attempt = 0; attempt < 5 && !el; attempt++) {
            if (attempt) await new Promise(r => setTimeout(r, 800));
            const handle = await page.evaluateHandle((text) => {
              // ARIA radio buttons (role="radio", common for custom-styled radio groups like
              // Google Forms) often have EMPTY textContent — their real label lives in
              // data-value or aria-label instead, so check those too, not just visible text.
              const ariaLabelOf = (e) => {
                const dv = e.getAttribute?.('data-value');
                if (dv) return dv.trim();
                const al = e.getAttribute?.('aria-label');
                return al ? al.split(',')[0].trim() : '';
              };
              const all = Array.from(document.querySelectorAll('li, label, [role="option"], [role="menuitem"], [role="radio"], button, a'));
              const target = all.find(e => e.textContent.trim() === text || ariaLabelOf(e) === text);
              return target ? (target.closest('li, [role="option"], [role="menuitem"], [role="radio"], button, a') || target) : null;
            }, targetLabel).catch(() => null);
            el = handle?.asElement() || null;
          }
          if (el) {
            await el.scrollIntoView().catch(() => {});
            await el.click().catch(() => {});
          } else {
            warnings.push(`Couldn't find the "${targetLabel}" option on screen for "${step.label || 'a choice field'}" — it may not have been selected.`);
          }
        } else {
          await page.waitForSelector(selector, { timeout: 3000 }).catch(() => {});
          let clicked = await page.click(selector).then(() => true).catch(() => false);
          if (!clicked) {
            // The native radio/checkbox <input> is very often visually hidden behind a styled
            // wrapper (MUI, Ant, Bootstrap all do this) — a direct page.click on the zero-size
            // input fails. Click the element that actually toggles it instead: its wrapping
            // <label>, or the on-screen element whose visible text matches the option label. Also
            // retries a few times since the panel this option lives in may have been opened by the
            // immediately preceding click step and may still be animating in.
            for (let attempt = 0; attempt < 4 && !clicked; attempt++) {
              if (attempt) await new Promise(r => setTimeout(r, 500));
              const handle = await page.evaluateHandle((sel, text) => {
                const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                const input = document.querySelector(sel);
                if (input) {
                  const lab = input.closest('label') ||
                    (input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`));
                  if (lab) return lab;
                }
                // Fall back to any visible clickable element showing the option's text
                const wl = norm(text);
                const cands = Array.from(document.querySelectorAll('label, li, [role="radio"], [role="option"], button, span, div'));
                return cands.find(e => e.offsetHeight > 0 && norm(e.textContent) === wl) || input || null;
              }, selector, targetLabel).catch(() => null);
              const el = handle?.asElement() || null;
              if (el) {
                await el.scrollIntoView().catch(() => {});
                clicked = await el.click().then(() => true).catch(() => false);
              }
            }
          }
          if (!clicked) warnings.push(`Couldn't find the "${targetLabel}" option on screen for "${step.label || 'a choice field'}" — it may not have been selected.`);
        }
        await new Promise(r => setTimeout(r, 400));
      } else if (step.type === 'date') {
        // Calendar date-cell pick — find whatever cell currently on screen carries the target
        // date in its aria-label, navigating forward with a best-effort "next"-labeled control if
        // the target month isn't visible yet (a common but not universal convention — highly
        // custom calendar widgets with no accessible markup at all can't be driven this way, the
        // same fundamental limit as a slider with no accessible markup).
        let target = step.value;
        if (step.isVariable && step.variableName && inputs[step.variableName] !== undefined) {
          target = inputs[step.variableName];
        }
        const dt = new Date(target);
        if (!isNaN(dt)) {
          const monthName = dt.toLocaleString('en-US', { month: 'long' });
          const day = dt.getDate();
          const year = dt.getFullYear();
          onProgress?.(`Selecting date ${monthName} ${day}, ${year}...`);
          const findDayEl = async () => {
            const handle = await page.evaluateHandle((mon, d, y) => {
              const re = new RegExp(`\\b${mon}\\s+${d}(st|nd|rd|th)?,?\\s+${y}\\b`, 'i');
              return Array.from(document.querySelectorAll('[aria-label]')).find(el => re.test(el.getAttribute('aria-label') || '')) || null;
            }, monthName, day, year).catch(() => null);
            return handle?.asElement() || null;
          };
          let dayEl = await findDayEl();
          for (let i = 0; i < 12 && !dayEl; i++) {
            const advanced = await page.evaluate(() => {
              const btn = Array.from(document.querySelectorAll('button, [role="button"]'))
                .find(b => /next/i.test(b.getAttribute('aria-label') || '') && b.offsetHeight > 0);
              if (btn) { btn.click(); return true; }
              return false;
            }).catch(() => false);
            if (!advanced) break;
            await new Promise(r => setTimeout(r, 350));
            dayEl = await findDayEl();
          }
          if (dayEl) {
            await dayEl.scrollIntoView().catch(() => {});
            await dayEl.click().catch(() => {});
          } else {
            warnings.push(`Couldn't find ${monthName} ${day}, ${year} on the "${step.label || 'date'}" calendar — it may not have been selected.`);
          }
        } else {
          warnings.push(`Couldn't understand "${target}" as a date for "${step.label || 'date'}" — it may not have been selected.`);
        }
        await new Promise(r => setTimeout(r, 400));
      } else if (step.type === 'autocomplete') {
        // ARIA combobox (typeahead) field — re-type the requested value fresh and click whatever
        // suggestion the site's own live search returns. The option recorded at capture time was
        // specific to the OLD typed text and generally won't exist at all if a different value is
        // requested now, so matching against it (like a static choice) would silently fail.
        let target = step.value;
        if (step.isVariable && step.variableName && inputs[step.variableName] !== undefined) {
          target = inputs[step.variableName];
        }
        onProgress?.(`Typing "${target}" into "${step.label || 'field'}"...`);
        await page.waitForSelector(step.selector, { timeout: 3000 }).catch(() => {});
        const comboEl = await pickEl(step);
        if (comboEl) {
          await comboEl.click({ clickCount: 3 }).catch(() => {});
          await comboEl.type(String(target), { delay: 60 }).catch(() => {});
          let optEl = null;
          for (let attempt = 0; attempt < 6 && !optEl; attempt++) {
            await new Promise(r => setTimeout(r, 500));
            const handle = await page.evaluateHandle((wanted) => {
              const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
              const opts = Array.from(document.querySelectorAll('[role="option"]')).filter(o => o.offsetHeight > 0);
              if (!opts.length) return null;
              const w = norm(wanted);
              return opts.find(o => norm(o.textContent).includes(w)) || opts[0];
            }, target).catch(() => null);
            optEl = handle?.asElement() || null;
          }
          if (optEl) {
            await optEl.scrollIntoView().catch(() => {});
            await optEl.click().catch(() => {});
          } else {
            warnings.push(`Typed "${target}" into "${step.label || 'field'}" but no suggestion appeared to pick — it may not have been set.`);
          }
        } else {
          warnings.push(`Couldn't find the "${step.label || 'field'}" autocomplete field on this run.`);
        }
        await new Promise(r => setTimeout(r, 400));
      } else if (step.type === 'slider') {
        let target = step.value;
        if (step.isVariable && step.variableName && inputs[step.variableName] !== undefined) {
          target = inputs[step.variableName];
        }
        const min = parseFloat(step.min), max = parseFloat(step.max);
        target = Math.max(min, Math.min(max, parseFloat(target)));
        onProgress?.(`Setting "${step.label || 'range'}" to ${target}...`);
        await page.waitForSelector(step.selector, { timeout: 3000 }).catch(() => {});
        const sliderEl = await pickEl(step);
        if (sliderEl) {
          const isNativeRange = await sliderEl.evaluate(el => el.tagName === 'INPUT' && el.type === 'range').catch(() => false);
          if (isNativeRange) {
            await sliderEl.evaluate((el, val) => {
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              setter.call(el, val);
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }, target).catch(() => {});
          } else {
            // Custom drag-slider widget — direct value assignment won't move its internal state,
            // so simulate a real mouse drag along the track to the proportional target position.
            const box = await sliderEl.boundingBox().catch(() => null);
            if (box && box.width > 0) {
              const ratio = Math.max(0, Math.min(1, (target - min) / ((max - min) || 1)));
              const y = box.y + box.height / 2;
              await page.mouse.move(box.x + box.width / 2, y);
              await page.mouse.down();
              await page.mouse.move(box.x + box.width * ratio, y, { steps: 15 });
              await page.mouse.up();
              await new Promise(r => setTimeout(r, 300));
            } else {
              warnings.push(`Couldn't measure the "${step.label || 'range'}" slider on this run — it may not have moved.`);
            }
          }
        } else {
          warnings.push(`Couldn't find the "${step.label || 'range'}" slider on this run.`);
        }
      } else if (step.type === 'toggle') {
        // On/off checkbox: honor the requested state (variable) or the recorded one,
        // clicking only if the current state differs.
        let desired = !!step.newState;
        if (step.isVariable && step.variableName && inputs[step.variableName] !== undefined) {
          desired = /^(y|yes|true|on|1|check)/i.test(String(inputs[step.variableName]).trim());
        }
        onProgress?.(`${desired ? 'Enabling' : 'Disabling'} "${step.label || 'option'}"...`);
        if (step.mode === 'text') {
          // ARIA checkbox (role="checkbox") — no real selector was recorded, so find the
          // element currently on screen by its label the same way choice's text-mode does, and
          // read/toggle aria-checked instead of a native .checked property.
          const handle = await page.evaluateHandle((text) => {
            const ariaLabelOf = (e) => {
              const dv = e.getAttribute?.('data-value');
              if (dv) return dv.trim();
              const al = e.getAttribute?.('aria-label');
              return al ? al.split(',')[0].trim() : '';
            };
            const all = Array.from(document.querySelectorAll('[role="checkbox"]'));
            return all.find(e => e.textContent.trim() === text || ariaLabelOf(e) === text) || null;
          }, step.label).catch(() => null);
          const el = handle?.asElement() || null;
          if (el) {
            const cur = await el.evaluate(e => e.getAttribute('aria-checked') === 'true').catch(() => null);
            if (cur !== null && cur !== desired) {
              await el.scrollIntoView().catch(() => {});
              await el.click().catch(() => {});
            }
          } else {
            warnings.push(`Couldn't find the "${step.label || 'option'}" checkbox on this run — it may not have been set.`);
          }
        } else {
          await page.waitForSelector(step.selector, { timeout: 3000 }).catch(() => {});
          const tEl = await pickEl(step);
          if (tEl) {
            const cur = await tEl.evaluate(el => !!el.checked).catch(() => null);
            if (cur !== null && cur !== desired) {
              await tEl.scrollIntoView().catch(() => {});
              await tEl.click().catch(() => {});
            }
          } else {
            warnings.push(`Couldn't find the "${step.label || 'option'}" checkbox on this run — it may not have been set.`);
          }
        }
        await new Promise(r => setTimeout(r, 400));
      } else if (step.type === 'stepper') {
        // Numeric stepper / quantity selector (e.g. passenger counts, ticket quantities) — no
        // fixed set of "options" exists here, just a running count and two buttons that move it
        // up or down. Reads the CURRENT live count (not the recorded one — it may already differ)
        // and clicks the recorded +/- button toward the requested target.
        let target = parseInt(step.value, 10);
        if (step.isVariable && step.variableName && inputs[step.variableName] !== undefined) {
          const parsed = parseInt(String(inputs[step.variableName]).replace(/[^0-9]/g, ''), 10);
          if (!isNaN(parsed)) target = parsed;
        }
        onProgress?.(`Setting "${step.label || 'count'}" to ${target}...`);
        // Anchor everything to the visible ROW LABEL ("Adults", "Children", ...) rather than the
        // generic global class selectors captured at record time (e.g. "p.MuiTypography-root",
        // which matches hundreds of elements — its positional index simply does not survive from
        // record to replay, which is what produced the "ended at NaN" failures). The label text is
        // a stable, human-meaningful anchor: find the element showing it, walk up to the row that
        // ALSO contains a bare number and 2+ buttons, then read the number and step the correct
        // button. dec = a button positioned before the number, inc = a button after it.
        const stepOnce = async (dir) => {
          return await page.evaluate((labelText, direction) => {
            const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            const wantL = norm(labelText);
            const labelEl = Array.from(document.querySelectorAll('p,span,label,div'))
              .find(e => e.children.length === 0 && e.offsetHeight > 0 && norm(e.textContent) === wantL);
            if (!labelEl) return { found: false };
            // climb to the smallest ancestor row that holds a numeric text node and 2+ buttons
            let row = labelEl;
            for (let i = 0; i < 6 && row; i++) {
              const btns = row.querySelectorAll('button');
              const numEl = Array.from(row.querySelectorAll('p,span,div'))
                .find(e => e.children.length === 0 && /^\d+$/.test((e.textContent || '').trim()));
              if (btns.length >= 2 && numEl) {
                const cur = parseInt(numEl.textContent.trim(), 10);
                if (direction === 0) return { found: true, current: cur };
                // order buttons by document position; those before the number decrement, after increment
                const numRect = numEl.getBoundingClientRect();
                const ordered = Array.from(btns).map(b => ({ b, x: b.getBoundingClientRect().left }))
                  .sort((a, z) => a.x - z.x).map(o => o.b);
                const before = ordered.filter(b => b.getBoundingClientRect().left < numRect.left);
                const after = ordered.filter(b => b.getBoundingClientRect().left >= numRect.right);
                const btn = direction > 0 ? (after[0] || ordered[ordered.length - 1]) : (before[before.length - 1] || ordered[0]);
                if (btn && !btn.disabled) { btn.click(); return { found: true, current: cur, clicked: true }; }
                return { found: true, current: cur, clicked: false };
              }
              row = row.parentElement;
            }
            return { found: false };
          }, step.label, dir).catch(() => ({ found: false }));
        };
        let res0 = await stepOnce(0);
        if (res0.found && !isNaN(target)) {
          let current = res0.current, guard = 0;
          while (current !== target && guard < 30) {
            const r = await stepOnce(current < target ? 1 : -1);
            if (!r.found || r.clicked === false) break;
            await new Promise(r => setTimeout(r, 200));
            const rc = await stepOnce(0);
            if (!rc.found) break;
            current = rc.current;
            guard++;
          }
          if (current !== target) {
            warnings.push(`Couldn't set "${step.label || 'count'}" to ${target} (ended at ${current}) — it may not be fully correct.`);
          }
        } else {
          warnings.push(`Couldn't find the "${step.label || 'count'}" counter on this run — it may not have been set.`);
        }
        await new Promise(r => setTimeout(r, 300));
      }
    }
    onProgress?.('Extracting results...');
    await new Promise(r => setTimeout(r, 1500));

    const data = await page.evaluate(() => {
      const clean = t => (t||'').replace(/\s+/g,' ').trim();
      return {
        title: document.title,
        url: window.location.href,
        headings: Array.from(document.querySelectorAll('h1,h2,h3,h4')).slice(0,12)
          .map(el => clean(el.textContent)).filter(Boolean),
        paragraphs: Array.from(document.querySelectorAll('p,li'))
          .map(el => clean(el.textContent)).filter(t => t.length > 15 && t.length < 400).slice(0,12),
        tables: Array.from(document.querySelectorAll('table')).slice(0,4).map(table => ({
          headers: Array.from(table.querySelectorAll('th')).map(th => clean(th.textContent)),
          rows: Array.from(table.querySelectorAll('tr')).slice(0,20).map(tr =>
            Array.from(tr.querySelectorAll('td,th')).map(td => clean(td.textContent))
          ).filter(r => r.some(c => c)),
        })).filter(t => t.rows.length > 0),
        // Extract visible text blocks (good for price/result cards)
        // Prioritize blocks that actually contain a price — on listing pages the first N matches
        // of a generic class-name selector are often nav/promo widgets, not the real results.
        textBlocks: (() => {
          const candidates = Array.from(document.querySelectorAll(
            '[class*="price"],[class*="result"],[class*="card"],[class*="item"],[class*="flight"],[class*="ticket"],[class*="offer"],[class*="product"],[class*="book"]'
          )).map(el => clean(el.textContent)).filter(t => t.length > 5 && t.length < 500);
          const hasPrice = t => /(\$|৳|tk\.?|₹|€|£)\s?[\d,]/i.test(t);
          const uniq = arr => [...new Set(arr)];
          return uniq([...candidates.filter(hasPrice), ...candidates.filter(t => !hasPrice(t))]).slice(0, 10);
        })(),
        // Generic repeated-structure detector: search results, job lists, and product grids are
        // always "many sibling elements that look alike". Find the container with the most
        // same-tagged, content-sized children — that IS the results list, regardless of the
        // site's framework or class-naming scheme (works even on Angular/React custom elements).
        listItems: (() => {
          // Only count truly visible elements — mega-menus and drawers sit hidden in the DOM
          // (display:none, visibility:hidden, opacity:0, or parked off-screen) with the same
          // "many similar siblings" shape as a results list.
          const visible = el => {
            try { if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false; } catch (_) {}
            const r = el.getBoundingClientRect();
            if (r.right <= 0 || r.bottom <= 0) return false;
            return r.width > 20 && r.height > 20;
          };
          const candidates = [];
          document.querySelectorAll('div, ul, ol, section, tbody, main').forEach(parent => {
            if (parent.closest('nav, header, footer, [role="navigation"]')) return;
            const kids = Array.from(parent.children).filter(k => {
              if (!visible(k)) return false;
              const t = clean(k.textContent);
              return t.length > 30 && t.length < 700;
            });
            if (kids.length < 3) return;
            const tagCounts = {};
            kids.forEach(k => { tagCounts[k.tagName] = (tagCounts[k.tagName] || 0) + 1; });
            const [domTag, domCount] = Object.entries(tagCounts).sort((a, b) => b[1] - a[1])[0];
            if (domCount < 3) return;
            const items = kids.filter(k => k.tagName === domTag);
            const avgLen = items.reduce((a, k) => a + clean(k.textContent).length, 0) / items.length;
            candidates.push({ items, score: items.length * Math.min(250, avgLen) });
          });
          candidates.sort((a, b) => b.score - a.score);
          const best = candidates[0];
          return best ? [...new Set(best.items.slice(0, 15).map(k => clean(k.textContent)))].filter(Boolean) : [];
        })(),
        links: Array.from(document.querySelectorAll('a[href]')).slice(0,15)
          .map(a => ({ text: clean(a.textContent), href: a.href })).filter(l => l.text.length > 2),
      };
    });
    clearTimeout(replayTimeout);
    await browser.close();
    return { ...data, warnings };
  } catch (err) {
    clearTimeout(replayTimeout);
    await browser.close();
    throw err;
  }
}

// ─── AI CHAT ENDPOINT (SSE streaming) ────────────────────────────────────────
app.post('/api/workflows/:id/chat', requireAuth, async (req, res) => {
  // All checks BEFORE SSE headers (once SSE starts we can't send JSON errors)
  const w = db.prepare('SELECT * FROM workflows WHERE id=?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'API not found.' });

  const isOwner = w.user_id === req.user.id;
  const bought  = isOwner ? null : db.prepare('SELECT id FROM purchases WHERE buyer_id=? AND workflow_id=?').get(req.user.id, req.params.id);
  if (!isOwner && !bought && w.price > 0) return res.status(403).json({ error: 'Purchase this API first.' });
  if (req.user.plan === 'free') return res.status(403).json({ error: 'Running APIs requires a paid plan.', upgradeRequired: true });

  const now = new Date();
  if (req.user.plan === 'monthly') {
    const ms = new Date(now.getFullYear(), now.getMonth(), 1);
    const cnt = db.prepare('SELECT COUNT(*) as c FROM usage_logs WHERE user_id=? AND created_at>=?').get(req.user.id, ms.toISOString()).c;
    if (cnt >= 500) return res.status(429).json({ error: 'Monthly limit reached!', upgradeRequired: true });
  }

  let credentialInputs;
  try { credentialInputs = resolvePerUserLogin(w, req.user.id); }
  catch (err) { return res.status(400).json({ error: err.message, needsLogin: true, loginDomain: w.login_domain }); }

  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'No message provided.' });

  // Switch to SSE mode
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const emit = (type, data) => { try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch(_) {} };

  const variables    = JSON.parse(w.variables     || '[]');
  const constants    = JSON.parse(w.constants     || '{}');
  const savedCookies = credentialInputs ? [] : decryptCookiesField(w.session_cookies);

  // ── Step 1: Understand the request with Claude ─────────────────────────────
  let inputs = {}, understood = '';
  if (ai) {
    emit('status', { text: 'Understanding your request...' });
    try {
      // Recorded field names/labels are raw text scraped from arbitrary web pages — they can
      // contain quotes, currency symbols, newlines, or other characters a smaller/free-tier model
      // can mangle when asked to reproduce them verbatim as a JSON key, breaking the whole
      // response (seen with a flight-result label like "US-Bangla Airlines৳ 9,974" picked up as a
      // toggle name). Exchanging safe, positional IDs ("v0", "v1"...) instead of the real name
      // removes this failure mode entirely, regardless of how messy any future site's own text is.
      const idToName = {};
      variables.forEach((v, vi) => { idToName['v' + vi] = v.name; });
      const varList = variables.length
        ? variables.map((v, vi) => {
            const id = 'v' + vi;
            if (v.type === 'choice') return `  - ${id}: label="${v.label||v.name}", type=choice, must be one of [${(v.options||[]).map(o=>`"${o}"`).join(', ')}], current="${v.defaultValue||''}"`;
            if (v.type === 'slider') return `  - ${id}: label="${v.label||v.name}", type=number, range ${v.min}-${v.max}, current=${v.defaultValue}`;
            if (v.type === 'stepper') return `  - ${id}: label="${v.label||v.name}", type=count — answer with a plain whole number (e.g. "3"), current=${v.defaultValue}`;
            if (v.type === 'toggle') return `  - ${id}: label="${v.label||v.name}", type=on/off toggle, answer "yes" or "no", current="${v.defaultValue||'no'}"`;
            if (v.type === 'action') return `  - ${id}: label="${v.label||v.name}", type=action — answer "yes" ONLY if the user explicitly asks to ${v.label||v.name}, otherwise "no"`;
            return `  - ${id}: label="${v.label||v.name}", example="${v.defaultValue||''}"`;
          }).join('\n')
        : '  (no variables — runs the same every time)';

      const raw = await askClaude(`You are filling in a web form for a user. Extract the values they want.

API: "${w.name}"
Today: ${new Date().toDateString()}

Variables to fill (use the id shown, e.g. "v0", as the JSON key — NOT the label):
${varList}

User said: "${message}"

Rules:
- Include EVERY variable listed above as a key in the JSON, using its id (v0, v1, ...) — no exceptions
- Match by the variable's label/MEANING, not wording — the user will almost never use that exact
  label. They might use a synonym, a shortened version, or just describe the field in passing
  (e.g. a variable labeled "Most Useful Aspect" should be filled from something like "the labs
  were the best part", one labeled "Instructor" should match "prof was Dr. Khan" or just
  "Dr. Khan"). Read the whole message once, decide which part of it belongs to which variable,
  then assign each piece — don't require the user to label their own sentence.
- Convert relative dates to real dates (e.g. "next friday" → "2026-07-03")
- For origin/destination: include city name as typed, e.g. "Dhaka", "Sylhet", "London"
- If user doesn't mention a variable at all, keep its current/example value — never invent one
- For "choice" variables, copy one of the listed options exactly — pick whichever best serves the user's intent (e.g. if they want "cheapest" or "lowest price", pick a low-to-high price sort option if one exists)
- For "number" (range) variables, output a plain number within the given range
- For "toggle" variables: "yes" or "no" based on what the user wants
- For "action" variables (like add to cart, buy, apply): "yes" when the user requests that action in any wording ("add 3 to cart", "put it in my cart", "buy it" → yes). "no" only if they did not ask for it
- For password/email fields: always use the example value unchanged

Return ONLY this JSON (no other text):
{"inputs":{"v0":"value"},"understood":"One sentence describing the task"}`, 500);

      // Extract JSON robustly — handle markdown fences and find balanced braces
      const cleaned = raw.replace(/```[\w]*\n?/g, '').replace(/\n?```/g, '').trim();
      const jsonStr = extractBalancedJSON(cleaned);
      const byId = {};
      let understoodRaw = '';
      // Primary path: strict parse of the whole object.
      try {
        const p = JSON.parse(jsonStr || cleaned);
        Object.assign(byId, p.inputs || {});
        understoodRaw = p.understood || '';
      } catch (_) {
        // The free/small model occasionally emits slightly malformed JSON (an unescaped quote or
        // symbol inside a value, a stray newline). Because we fully control the key format (v0, v1,
        // ...), we can salvage each value directly with a targeted regex over the raw text instead
        // of failing the entire request over one bad character. This makes a formatting slip a
        // non-event rather than a hard crash the user can't do anything about.
        const src = jsonStr || cleaned;
        const strRe = /"(v\d+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;   // string values
        const numRe = /"(v\d+)"\s*:\s*(-?\d+(?:\.\d+)?)/g;      // bare number values
        let m;
        while ((m = strRe.exec(src))) byId[m[1]] = m[2].replace(/\\"/g, '"');
        while ((m = numRe.exec(src))) if (byId[m[1]] === undefined) byId[m[1]] = m[2];
        const um = src.match(/"understood"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (um) understoodRaw = um[1].replace(/\\"/g, '"');
      }
      // Map the safe "v0"/"v1" ids the model used back to the real (possibly messy) variable names.
      const byRealName = {};
      Object.entries(byId).forEach(([id, val]) => {
        const realName = idToName[id];
        if (realName) byRealName[realName] = val;
      });
      inputs     = { ...constants, ...byRealName };
      understood = understoodRaw || '';
    } catch (aiErr) {
      // Never hard-fail the whole run on an AI hiccup — fall through and replay with recorded
      // defaults (backfilled just below), which at least reproduces the original recorded search.
      console.log('[chat] AI extraction error (continuing with defaults):', aiErr.message);
    }
  }

  // Fall back to defaults if AI failed or not configured
  if (!Object.keys(inputs).length) {
    variables.forEach(v => { inputs[v.name] = v.defaultValue || ''; });
    Object.assign(inputs, constants);
  }
  // Backfill any variable the AI left out (small models skip keys) with its recorded default
  variables.forEach(v => { if (inputs[v.name] === undefined) inputs[v.name] = v.defaultValue || ''; });
  // Deterministic safety net for actions: if the user's message plainly contains the action's
  // label words ("add ... to cart"), honor it even when a weak model answered "no".
  const msgLower = ` ${message.toLowerCase()} `;
  variables.forEach(v => {
    if (v.type !== 'action') return;
    const words = String(v.label || v.name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (words.length && words.every(wd => msgLower.includes(wd))) inputs[v.name] = 'yes';
  });
  if (credentialInputs) Object.assign(inputs, credentialInputs);
  console.log(`[chat] "${w.name}" message="${message}" → inputs=${JSON.stringify({ ...inputs, __credential_password: inputs.__credential_password ? '(hidden)' : undefined })}`);
  if (!understood) understood = `Running ${w.name}...`;

  emit('understood', { text: understood });

  // ── Step 2: Replay the workflow ────────────────────────────────────────────
  logUsage(req.user.id, 'call', w.id);
  db.prepare('UPDATE workflows SET call_count=call_count+1, last_run=CURRENT_TIMESTAMP WHERE id=?').run(w.id);

  let result;
  try {
    result = await replayWorkflow(
      JSON.parse(w.steps || '[]'),
      inputs,
      savedCookies,
      (msg) => emit('progress', { text: msg })
    );
  } catch (err) {
    const isBlocked = err.message.startsWith('BOT_BLOCKED');
    const blockedUrl = isBlocked ? err.message.split('BOT_BLOCKED:')[1] || '' : '';
    const isGoogle = blockedUrl.includes('google.com');
    emit('result', {
      text: isBlocked
        ? isGoogle
          ? `🚫 Your recording starts at **Google.com** instead of going directly to the travel site.\n\n**How to fix:**\n1. Delete this API (🗑 button)\n2. Click + Record New API\n3. In the Chrome window that opens — click the **address bar at the top** and type the website URL directly (e.g. \`gozayaan.com\`)\n4. Don't search for it on Google — go directly!`
          : `🚫 ${blockedUrl ? new URL(blockedUrl).hostname : 'The website'} blocked the automated browser (Cloudflare protection).\n\nDelete this API, re-record going directly to the site URL.`
        : '⚠️ Something went wrong: ' + err.message,
      data: {},
      actionLabel: isBlocked ? 'Delete & Re-record' : 'Try Again',
      actionUrl: null,
    });
    return res.end();
  }

  // ── Step 3: Summarize with Claude ─────────────────────────────────────────
  let summary = '', actionLabel = 'Open Page';
  if (ai) {
    emit('status', { text: 'Reading the results...' });
    try {
      const snippet = [
        result.title,
        // listItems (the detected results list) is the most reliable signal — feed it first
        ...(result.listItems||[]).slice(0,10),
        ...result.headings.slice(0,5),
        ...(result.textBlocks||[]).slice(0,5),
        ...(result.paragraphs||[]).slice(0,4),
        ...(result.tables||[]).flatMap(t => t.rows.slice(0,3).map(r => r.join(' | '))),
      ].join('\n').slice(0, 2200);

      const raw = await askClaude(`Task: "${understood}"
URL: ${result.url}
Title: "${result.title}"
Page content:
${snippet}

Summarize in 2-3 sentences what was found. Be specific about prices, names, results visible.
If you see "CAPTCHA", "robot", "blocked", "access denied", "press and hold" — say: "⚠️ The website blocked the automated browser. This site has very aggressive bot protection. Try a similar site like Google Flights, Kayak, or Momondo instead."

Last line must be: ACTION: [2-3 word action label e.g. "Book Cheapest", "View Flights", "Check Price"]`, 400);

      const am = raw.match(/ACTION:\s*(.+)/i);
      actionLabel = am ? am[1].trim().replace(/['"]/g,'') : 'Open Page';
      summary = raw.replace(/ACTION:.*$/im,'').trim();
    } catch (_) {
      summary = result.title || 'Completed.';
    }
  } else {
    summary = `⚠️ Add ANTHROPIC_API_KEY to .env for AI summaries. Landed on: ${result.title}`;
    actionLabel = 'Open Page';
  }

  // Surface any field the replay couldn't confidently set, instead of silently reporting success
  // regardless — the end user has no server logs to check, so this is the only place they'd ever
  // find out a field didn't actually get applied this run.
  if (result.warnings && result.warnings.length) {
    summary += `\n\n⚠️ ${result.warnings.join(' ')}`;
  }

  // Never echo credential values back to the browser, even the owning user's own — it's an
  // unnecessary trip for a secret to take, and this payload could end up in client-side logs.
  const { __credential_email, __credential_password, ...inputsUsed } = inputs;
  emit('result', { summary, actionLabel, result, inputsUsed, warnings: result.warnings || [] });
  res.end();
});

// ─── MARKETPLACE ─────────────────────────────────────────────────────────────
app.get('/api/marketplace', requireAuth, (req, res) => {
  const items = db.prepare(`
    SELECT w.id, w.name, w.description, w.url, w.price, w.price_description,
           w.call_count, w.created_at, w.variables,
           u.name as seller_name, u.avatar as seller_avatar,
           (SELECT COUNT(*) FROM purchases p WHERE p.workflow_id = w.id) as buyers
    FROM workflows w JOIN users u ON w.user_id = u.id
    WHERE w.is_public = 1
    ORDER BY w.call_count DESC, w.created_at DESC
  `).all();
  res.json(items.map(i => ({ ...i, variables: JSON.parse(i.variables || '[]') })));
});

app.post('/api/marketplace/:id/purchase', requireAuth, (req, res) => {
  const w = db.prepare('SELECT * FROM workflows WHERE id=? AND is_public=1').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found in marketplace.' });
  if (w.user_id === req.user.id) return res.status(400).json({ error: "You own this API already." });

  const already = db.prepare('SELECT id FROM purchases WHERE buyer_id=? AND workflow_id=?').get(req.user.id, req.params.id);
  if (already) return res.status(400).json({ error: 'You already own this API.' });

  if (w.price > 0) return res.json({ requiresPayment: true, price: w.price, workflowId: w.id });

  db.prepare('INSERT INTO purchases (id,buyer_id,workflow_id,seller_id,amount) VALUES (?,?,?,?,0)')
    .run(uuidv4(), req.user.id, req.params.id, w.user_id);
  res.json({ success: true, message: 'API added to your collection!' });
});

app.get('/api/my-purchased', requireAuth, (req, res) => {
  const items = db.prepare(`
    SELECT w.*, u.name as seller_name FROM purchases p
    JOIN workflows w ON p.workflow_id = w.id
    JOIN users u ON w.user_id = u.id
    WHERE p.buyer_id = ?
  `).all(req.user.id);
  res.json(items.map(parseWf));
});

// ─── USERS (admin) ────────────────────────────────────────────────────────────
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id,name,email,plan,plan_expires_at,created_at FROM users ORDER BY created_at DESC').all());
});

// Owner-only manual access grant — bypasses payment entirely (requireAdmin already restricts
// this to exactly ADMIN_EMAIL; no other user can reach or even see this feature).
app.get('/api/admin/users/search', requireAuth, requireAdmin, (req, res) => {
  const q = `%${(req.query.q || '').trim()}%`;
  const rows = db.prepare('SELECT id,name,email,plan,plan_expires_at,created_at FROM users WHERE email LIKE ? OR name LIKE ? ORDER BY created_at DESC LIMIT 20').all(q, q);
  res.json(rows);
});

const ADMIN_GRANTABLE_PLANS = ['free', 'monthly', 'yearly'];
app.post('/api/admin/users/:id/grant', requireAuth, requireAdmin, (req, res) => {
  const { plan, months } = req.body;
  if (!ADMIN_GRANTABLE_PLANS.includes(plan)) return res.status(400).json({ error: 'Plan must be free, monthly, or yearly.' });
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  let expires = null;
  if (plan !== 'free') {
    expires = new Date();
    expires.setMonth(expires.getMonth() + (parseInt(months, 10) || (plan === 'yearly' ? 12 : 1)));
  }
  db.prepare('UPDATE users SET plan=?, plan_expires_at=? WHERE id=?').run(plan, expires ? expires.toISOString() : null, user.id);
  res.json({ success: true, user: { id: user.id, email: user.email, plan, plan_expires_at: expires ? expires.toISOString() : null } });
});

// ─── SPA FALLBACK ─────────────────────────────────────────────────────────────
app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   Shadman's API Platform is running!     ║
║   Open: http://localhost:${PORT}             ║
║   Admin: ${process.env.ADMIN_EMAIL}  ║
╚══════════════════════════════════════════╝`);
});
