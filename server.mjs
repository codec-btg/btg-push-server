// push-server/server.mjs — Free Push Notification Server
// Deploy free on: Render.com / Railway.app / Vercel Functions
//
// Setup:
//   1. cd push-server && npm init -y && npm install express web-push dotenv
//   2. Copy VAPID keys from `node generate-vapid.mjs` into .env
//   3. Run: node server.mjs
//
// .env template:
//   PORT=3001
//   VAPID_PUBLIC_KEY=...
//   VAPID_PRIVATE_KEY=...
//   VAPID_EMAIL=mailto:hr@betagro.com
//   ALLOWED_ORIGIN=https://your-hr-portal.com

import 'dotenv/config';
import express    from 'express';
import webpush    from 'web-push';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const app  = express();
const PORT = process.env.PORT ?? 3001;
const DB   = './subscriptions.json'; // simple file-based store (use DB in prod)

app.use(express.json());
app.use((req, res, next) => {
  const origin = req.headers.origin ?? '';
  const allowed = process.env.ALLOWED_ORIGIN ?? '';
  // Allow any localhost port in dev, or exact match in prod
  const isLocalhost = /^https?:\/\/localhost(:\d+)?$/.test(origin);
  if (isLocalhost || origin === allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

webpush.setVapidDetails(
  process.env.VAPID_EMAIL        ?? 'mailto:hr@betagro.com',
  process.env.VAPID_PUBLIC_KEY   ?? '',
  process.env.VAPID_PRIVATE_KEY  ?? ''
);

// ── In-memory subscription store (backed by file) ──
function loadSubs() {
  if (!existsSync(DB)) return [];
  try { return JSON.parse(readFileSync(DB, 'utf8')); } catch { return []; }
}
function saveSubs(subs) {
  writeFileSync(DB, JSON.stringify(subs, null, 2));
}

// ── POST /subscribe  — save a browser subscription ──
app.post('/subscribe', (req, res) => {
  const { endpoint, expirationTime, keys, user } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  const subs = loadSubs();
  const existing = subs.find(s => s.endpoint === endpoint);
  if (existing) {
    if (user) existing.user = user;
    saveSubs(subs);
  } else {
    subs.push({ endpoint, expirationTime: expirationTime ?? null, keys, user: user ?? {}, groups: [], subscribedAt: new Date().toISOString() });
    saveSubs(subs);
  }
  res.status(201).json({ ok: true });
});

// ── DELETE /subscribe — remove a subscription ──
app.delete('/subscribe', (req, res) => {
  const { endpoint } = req.body;
  saveSubs(loadSubs().filter(s => s.endpoint !== endpoint));
  res.json({ ok: true });
});

// ── POST /send — send a targeted push notification ──
app.post('/send', async (req, res) => {
  if (process.env.PUSH_SECRET && req.body.secret !== process.env.PUSH_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { title = 'Betagro HR Portal', body = '', url = '/', tag = 'btg-hr', icon, targets } = req.body;
  const payload = JSON.stringify({ title, body, url, tag, icon: icon ?? '/icon-192.svg' });

  let subs = loadSubs();
  if (targets?.type === 'groups' && targets.values?.length > 0) {
    subs = subs.filter(s => (s.groups ?? []).some(g => targets.values.includes(g)));
  } else if (targets?.type === 'users' && targets.values?.length > 0) {
    subs = subs.filter(s => targets.values.includes(s.endpoint));
  }

  const results = await Promise.allSettled(
    subs.map(sub => webpush.sendNotification(sub, payload))
  );
  const failed = results.filter(r => r.status === 'rejected').length;
  console.log(`[Push] Sent ${subs.length - failed}/${subs.length} (target: ${targets?.type ?? 'all'})`);
  res.json({ sent: subs.length - failed, failed, total: loadSubs().length });
});

// ── GET /subscribers — return subscriber list with user & group info ──
app.get('/subscribers', (_req, res) => {
  const subs = loadSubs();
  res.json({
    count: subs.length,
    subscribers: subs.map(s => ({
      endpoint: s.endpoint,
      user: s.user ?? {},
      groups: s.groups ?? [],
      subscribedAt: s.subscribedAt,
    })),
  });
});

// ── PATCH /subscribers/groups — assign groups to a subscriber ──
app.patch('/subscribers/groups', (req, res) => {
  const { endpoint, groups } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
  const subs = loadSubs();
  const sub = subs.find(s => s.endpoint === endpoint);
  if (!sub) return res.status(404).json({ error: 'Subscriber not found' });
  sub.groups = Array.isArray(groups) ? groups : [];
  saveSubs(subs);
  res.json({ ok: true, groups: sub.groups });
});

// ── GET /vapid-public-key — let frontend fetch the key ──
app.get('/vapid-public-key', (_req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY ?? '' });
});

app.listen(PORT, () => console.log(`\n🔔 Push server running on :${PORT}\n`));
