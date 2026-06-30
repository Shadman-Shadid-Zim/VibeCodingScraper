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
const Anthropic      = require('@anthropic-ai/sdk');

const ai = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

async function askClaude(prompt, maxTokens = 600) {
  if (!ai) throw new Error('ANTHROPIC_API_KEY not set in .env');
  const r = await ai.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  return r.content[0].text.trim();
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
    last_run TEXT
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
            if (el.className) {
              const cls = el.className.split(' ').find(c => /^[a-zA-Z]/.test(c));
              if (cls) return `${tag}.${cls}`;
            }
            return tag;
          };

          const getLabel = (el) =>
            el.getAttribute('aria-label') || el.placeholder || el.name || el.id ||
            (el.textContent || '').trim().substring(0, 30) || el.tagName.toLowerCase();

          let actionCount = 0;
          const updateCount = () => {
            const el = document.getElementById('__sapi_count');
            if (el) el.textContent = `${++actionCount} action${actionCount === 1 ? '' : 's'}`;
          };

          document.addEventListener('click', (e) => {
            if (e.target.closest('#__sapi_bar')) return;
            const sel = generateSelector(e.target);
            window.__recordAction({ type: 'click', selector: sel, tag: e.target.tagName.toLowerCase(), label: getLabel(e.target) });
            updateCount();
          }, true);

          document.addEventListener('change', (e) => {
            const el = e.target;
            if (!['INPUT','TEXTAREA','SELECT'].includes(el.tagName)) return;
            const sel = generateSelector(el);
            window.__recordAction({ type: 'fill', selector: sel, value: el.value, label: getLabel(el), inputType: el.type || 'text', tag: el.tagName.toLowerCase() });
            updateCount();
          }, true);
        });
      } catch (_) {}
    };

    page.on('framenavigated', async (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (!url || url === 'about:blank') return;
      steps.push({ type: 'navigate', url, timestamp: Date.now() });
      await new Promise(r => setTimeout(r, 600));
      await injectRecorder(frame);
    });

    // Start screen
    await page.evaluate(() => {
      document.body.style.cssText = 'margin:0;background:#0f0f23;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:Arial,sans-serif;';
      document.body.innerHTML = `
        <div style="padding:40px;max-width:560px;width:100%;">
          <div style="text-align:center;margin-bottom:28px;">
            <div style="font-size:52px;margin-bottom:12px;">🎙️</div>
            <h1 style="color:#a5b4fc;font-size:24px;margin:0 0 8px;">Recording Started!</h1>
            <p style="color:#94a3b8;font-size:14px;line-height:1.6;margin:0;">
              Type any website URL in the address bar and do your task.<br>
              Every click and form fill is captured automatically.
            </p>
          </div>

          <div style="background:#1a1a3e;border:1px solid #312e81;border-radius:12px;padding:18px;margin-bottom:16px;font-size:13px;text-align:left;">
            <p style="margin:0 0 10px;color:#6366f1;font-weight:bold;font-size:14px;">📋 What to record:</p>
            <p style="margin:5px 0;color:#94a3b8;">• Search for flights on <strong style="color:#e2e8f0;">skyscanner.net</strong></p>
            <p style="margin:5px 0;color:#94a3b8;">• Look up a stock on <strong style="color:#e2e8f0;">dsebd.org</strong></p>
            <p style="margin:5px 0;color:#94a3b8;">• Search a movie on <strong style="color:#e2e8f0;">imdb.com</strong></p>
            <p style="margin:5px 0;color:#94a3b8;">• Fill any form or do any task on any website</p>
          </div>

          <div style="background:#1a0a00;border:1px solid #92400e;border-radius:12px;padding:16px;font-size:13px;text-align:left;">
            <p style="margin:0 0 8px;color:#f59e0b;font-weight:bold;">⚠️ If the website requires login first:</p>
            <p style="margin:4px 0;color:#d97706;">1. Log in to the website using your <strong>email & password</strong> (not Google Sign-In — Google blocks automated browsers)</p>
            <p style="margin:4px 0;color:#d97706;">2. Once you are logged in, do your task normally</p>
            <p style="margin:8px 0 0;color:#92400e;font-size:12px;">Google Sign-In inside this recording browser will not work — it detects automated browsers.</p>
          </div>

          <p style="color:#475569;font-size:12px;margin-top:16px;text-align:center;">When done, click the red ⏹ Stop & Save button in the top toolbar.</p>
        </div>`;
    });

    activeSessions.set(sessionId, { browser, page, steps, stopped: false });
    res.json({ success: true, sessionId });
  } catch (err) {
    res.status(500).json({ error: 'Could not start recording: ' + err.message });
  }
});

app.get('/api/recording/status/:sessionId', requireAuth, (req, res) => {
  const s = activeSessions.get(req.params.sessionId);
  if (!s) return res.json({ active: false, stopped: true, steps: [] });
  if (s.stopped) {
    const steps = s.steps || [];
    activeSessions.delete(req.params.sessionId);
    return res.json({ active: false, stopped: true, steps });
  }
  res.json({ active: true, stopped: false, stepCount: s.steps.length });
});

app.post('/api/recording/stop/:sessionId', requireAuth, async (req, res) => {
  const s = activeSessions.get(req.params.sessionId);
  if (!s) return res.status(404).json({ error: 'Session not found.' });

  const steps = s.steps || [];
  try { await s.browser?.close(); } catch (_) {}
  activeSessions.delete(req.params.sessionId);
  logUsage(req.user.id, 'record');

  // Deduplicate rapid clicks
  const clean = steps.filter((step, i) => {
    if (i === 0) return true;
    const prev = steps[i - 1];
    if (step.type === 'click' && prev.type === 'click' && step.selector === prev.selector && step.timestamp - prev.timestamp < 400) return false;
    return true;
  });

  res.json({ success: true, steps: clean });
});

// ─── WORKFLOW ROUTES ──────────────────────────────────────────────────────────
const parseWf = (w) => w ? ({
  ...w,
  steps:     JSON.parse(w.steps     || '[]'),
  variables: JSON.parse(w.variables || '[]'),
  constants: JSON.parse(w.constants || '{}'),
}) : null;

app.get('/api/workflows', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM workflows WHERE user_id=? ORDER BY created_at DESC').all(req.user.id).map(parseWf));
});

app.post('/api/workflows', requireAuth, (req, res) => {
  const { name, description, url, steps, variables, constants } = req.body;
  if (!name) return res.status(400).json({ error: 'API name is required.' });
  const id = uuidv4();
  db.prepare('INSERT INTO workflows (id,user_id,name,description,url,steps,variables,constants) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, req.user.id, name, description || '', url || '', JSON.stringify(steps || []), JSON.stringify(variables || []), JSON.stringify(constants || {}));
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
  const { name, description, is_public, price, price_description, variables, constants } = req.body;
  db.prepare('UPDATE workflows SET name=?,description=?,is_public=?,price=?,price_description=?,variables=?,constants=? WHERE id=?')
    .run(name || w.name, description ?? w.description, is_public ? 1 : 0, price ?? 0, price_description ?? '', JSON.stringify(variables || []), JSON.stringify(constants || {}), w.id);
  res.json({ success: true });
});

app.delete('/api/workflows/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM workflows WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

app.post('/api/workflows/:id/call', requireAuth, checkUsageLimit, async (req, res) => {
  const w = db.prepare('SELECT * FROM workflows WHERE id=?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'API not found.' });

  const isOwner = w.user_id === req.user.id;
  const bought  = db.prepare('SELECT id FROM purchases WHERE buyer_id=? AND workflow_id=?').get(req.user.id, req.params.id);
  if (!isOwner && !bought && w.price > 0) return res.status(403).json({ error: 'Purchase this API first.' });
  if (req.user.plan === 'free') return res.status(403).json({ error: 'Calling APIs requires a paid plan. Please upgrade.', upgradeRequired: true });

  logUsage(req.user.id, 'call', w.id);
  db.prepare('UPDATE workflows SET call_count=call_count+1, last_run=CURRENT_TIMESTAMP WHERE id=?').run(w.id);

  const steps     = JSON.parse(w.steps     || '[]');
  const constants = JSON.parse(w.constants || '{}');
  const inputs    = { ...constants, ...(req.body.inputs || {}) };

  try {
    const result = await replayWorkflow(steps, inputs);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: 'Execution failed: ' + err.message });
  }
});

async function replayWorkflow(steps, inputs) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');

  // Block images/fonts/media to make pages load faster
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['image','font','media','stylesheet'].includes(req.resourceType())) req.abort();
    else req.continue();
  });

  try {
    for (const step of steps) {
      if (step.type === 'navigate') {
        await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 400));
      } else if (step.type === 'click') {
        await page.waitForSelector(step.selector, { timeout: 3000 }).catch(() => {});
        await page.click(step.selector).catch(() => {});
        // Wait for potential navigation or AJAX
        await Promise.race([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 4000 }).catch(() => {}),
          new Promise(r => setTimeout(r, 250)),
        ]);
      } else if (step.type === 'fill') {
        let value = step.value;
        if (step.isVariable && step.variableName && inputs[step.variableName] !== undefined) {
          value = inputs[step.variableName];
        }
        await page.waitForSelector(step.selector, { timeout: 3000 }).catch(() => {});
        await page.click(step.selector, { clickCount: 3 }).catch(() => {});
        // Clear first then type
        await page.evaluate(sel => { const el = document.querySelector(sel); if(el) el.value=''; }, step.selector).catch(() => {});
        await page.type(step.selector, String(value), { delay: 40 }).catch(() => {});
        await new Promise(r => setTimeout(r, 120));
      }
    }
    // Final wait for results to render
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
        textBlocks: Array.from(document.querySelectorAll('[class*="price"],[class*="result"],[class*="card"],[class*="item"],[class*="flight"],[class*="ticket"],[class*="offer"]'))
          .slice(0,8).map(el => clean(el.textContent)).filter(t => t.length > 5 && t.length < 500),
        links: Array.from(document.querySelectorAll('a[href]')).slice(0,15)
          .map(a => ({ text: clean(a.textContent), href: a.href })).filter(l => l.text.length > 2),
      };
    });
    await browser.close();
    return data;
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// ─── AI CHAT ENDPOINT ────────────────────────────────────────────────────────
app.post('/api/workflows/:id/chat', requireAuth, checkUsageLimit, async (req, res) => {
  const w = db.prepare('SELECT * FROM workflows WHERE id=?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'API not found.' });

  const isOwner = w.user_id === req.user.id;
  const bought  = db.prepare('SELECT id FROM purchases WHERE buyer_id=? AND workflow_id=?').get(req.user.id, req.params.id);
  if (!isOwner && !bought && w.price > 0) return res.status(403).json({ error: 'Purchase this API first.' });
  if (req.user.plan === 'free') return res.status(403).json({ error: 'Running APIs requires a paid plan. Please upgrade.', upgradeRequired: true });

  const variables = JSON.parse(w.variables || '[]');
  const constants  = JSON.parse(w.constants  || '{}');
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'No message provided.' });

  // Step 1 — Extract variable values from natural language using Claude
  let inputs = {};
  let understood = '';
  try {
    const varList = variables.length
      ? variables.map(v => `  - ${v.name} (label: "${v.label||v.name}", recorded value: "${v.defaultValue||''}")`).join('\n')
      : '  (no variables — this API runs the same way every time)';

    const raw = await askClaude(`You help extract form field values from a user's natural language request for a web automation task.

API Name: "${w.name}"
API Description: "${w.description || 'Not provided'}"
Variables this API needs:
${varList}

User's request: "${message}"

Instructions:
- Extract a value for EVERY variable from the user's message
- For travel: extract origin city/airport, destination city/airport, departure date, return date, passenger count
- For dates: convert "next friday", "July 20", "next week" to a real date string (today is ${new Date().toDateString()})
- For airports: use full name if known, e.g. "Dhaka (DAC)", "London Heathrow (LHR)"
- If a variable is not mentioned, use its recorded value as-is
- For email/login fields: always use the recorded default value unchanged

Respond with ONLY valid JSON:
{
  "inputs": { "variableName": "value", ... },
  "understood": "One short sentence describing the task, e.g. 'Searching for flights from Dhaka to London on 15 July, returning 25 July'"
}`, 700);

    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      inputs = { ...constants, ...(parsed.inputs || {}) };
      understood = parsed.understood || 'Running your request...';
    }
  } catch (err) {
    // Fall back to recorded defaults if AI fails
    variables.forEach(v => { inputs[v.name] = v.defaultValue || ''; });
    Object.assign(inputs, constants);
    understood = 'Running with your inputs...';
  }

  // Step 2 — Replay the workflow
  logUsage(req.user.id, 'call', w.id);
  db.prepare('UPDATE workflows SET call_count=call_count+1, last_run=CURRENT_TIMESTAMP WHERE id=?').run(w.id);

  const steps = JSON.parse(w.steps || '[]');
  let result;
  try {
    result = await replayWorkflow(steps, inputs);
  } catch (err) {
    return res.status(500).json({ error: 'Execution failed: ' + err.message, understood });
  }

  // Step 3 — Summarize and generate smart action buttons using Claude
  let summary = '';
  let actionLabel = 'Search Again';
  try {
    const pageText = [
      result.title,
      ...result.headings.slice(0,5),
      ...result.paragraphs.slice(0,6),
      ...result.textBlocks.slice(0,5),
      ...(result.tables||[]).flatMap(t => t.rows.slice(0,4).map(r => r.join(' | '))),
    ].join('\n').slice(0, 2000);

    const summaryRaw = await askClaude(`A web automation ran this task: "${understood}"
It landed on: ${result.url}
Page title: "${result.title}"
Page content:
${pageText}

Write 2–4 sentences summarizing what was found. Be specific: mention prices, flight names, times, stocks, or whatever data is visible.
If the page shows a CAPTCHA ("Are you a robot?"), say: "The website showed a CAPTCHA challenge. Try running again or log in manually first."
If the page shows an error or login wall, say so clearly.

Also on the last line write: ACTION: [short 2-word action label for a button, like "Book Flight", "Buy Ticket", "View Stock", "See Results", "Search Again"]`, 500);

    const actionMatch = summaryRaw.match(/ACTION:\s*(.+)/i);
    if (actionMatch) {
      actionLabel = actionMatch[1].trim().replace(/['"]/g, '');
      summary = summaryRaw.replace(/ACTION:.*$/im, '').trim();
    } else {
      summary = summaryRaw;
    }
  } catch (_) {
    summary = `Completed. Landed on: ${result.title || result.url}`;
  }

  res.json({ success: true, understood, summary, actionLabel, result, inputsUsed: inputs });
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
