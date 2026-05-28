/**
 * EVO Dashboard v2 — Equinoxes
 * ─────────────────────────────
 * Variables d'environnement (Coolify) :
 *   AXONAUT_API_KEY   — clé API Axonaut
 *   ADMIN_PASSWORD    — mot de passe interface admin
 *   SMTP_HOST         — ex: ssl0.ovh.net
 *   SMTP_PORT         — ex: 465
 *   SMTP_USER         — email expéditeur
 *   SMTP_PASS         — mot de passe SMTP
 *   LINK_EVO_2H      — lien Axonaut produit EVO 2h
 *   LINK_EVO_4H      — lien Axonaut produit EVO 4h
 *   LINK_EVO_10H     — lien Axonaut produit EVO 10h
 *   PORT              — port (défaut 3000)
 *   DB_PATH           — chemin SQLite (défaut /data/evo.db)
 */

const http       = require('http');
const https      = require('https');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');
const Database   = require('better-sqlite3');

// ── CONFIG ──────────────────────────────────────────────
const PORT        = process.env.PORT || 3000;
const API_KEY     = process.env.AXONAUT_API_KEY || '';
const ADMIN_PASS  = process.env.ADMIN_PASSWORD || 'admin';
const DB_PATH     = process.env.DB_PATH || '/data/evo.db';
const EVO_IDS     = [2452592, 2452594, 2452595];
const EVO_HOURS   = { 2452592: 2, 2452594: 4, 2452595: 10 };
const EVO_LABELS  = { 2452592: 'EVO 2h', 2452594: 'EVO 4h', 2452595: 'EVO 10h' };
const LINKS = {
  '2h':  process.env.LINK_EVO_2H  || '',
  '4h':  process.env.LINK_EVO_4H  || '',
  '10h': process.env.LINK_EVO_10H || '',
};

// ── BASE DE DONNÉES ──────────────────────────────────────
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY,
    name TEXT,
    email TEXT,
    city TEXT,
    updated_at INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY,
    company_id INTEGER,
    name TEXT,
    actual_hours REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER,
    invoice_num TEXT,
    invoice_date TEXT,
    product_id INTEGER,
    label TEXT,
    hours REAL,
    qty INTEGER
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY,
    company_id INTEGER,
    project_id INTEGER,
    project_name TEXT,
    title TEXT,
    reference TEXT,
    is_closed INTEGER DEFAULT 0,
    creation_date TEXT,
    hours REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS otp_sessions (
    token TEXT PRIMARY KEY,
    company_id INTEGER,
    email TEXT,
    code TEXT,
    expires_at INTEGER,
    verified INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY,
    created_at INTEGER,
    expires_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS client_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER,
    company_name TEXT,
    email TEXT,
    ip TEXT,
    logged_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER,
    finished_at INTEGER,
    status TEXT,
    message TEXT
  );
`);

// ── NODEMAILER ───────────────────────────────────────────
const mailer = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'ssl0.ovh.net',
  port:   parseInt(process.env.SMTP_PORT || '465'),
  secure: parseInt(process.env.SMTP_PORT || '465') === 465,
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  }
});

// ── AXONAUT API ──────────────────────────────────────────
function axoGet(path, page = 1) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'axonaut.com',
      port: 443,
      path,
      headers: {
        'userApiKey': API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'page': String(page),
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(new Error('JSON parse error: ' + data.slice(0, 100))); }
      });
    });
    req.on('error', reject);
  });
}

async function axoAll(path) {
  let page = 1, all = [];
  while (true) {
    const { status, body } = await axoGet(path, page);
    if (status !== 200) break;
    const items = Array.isArray(body) ? body : [];
    all = all.concat(items);
    if (items.length < 500) break;
    page++;
  }
  return all;
}

// ── SYNC AXONAUT → SQLITE ────────────────────────────────
let syncRunning = false;

async function syncAll() {
  if (syncRunning) return { ok: false, message: 'Sync déjà en cours' };
  syncRunning = true;
  const started = Math.floor(Date.now() / 1000);
  console.log('[SYNC] Démarrage sync Axonaut…');

  try {
    // 1. Entreprises
    console.log('[SYNC] Chargement entreprises…');
    const companies = await axoAll('/api/v2/companies');
    const upsertCo = db.prepare(`
      INSERT INTO companies (id, name, email, city, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, email=excluded.email,
        city=excluded.city, updated_at=excluded.updated_at
    `);
    const insertAllCo = db.transaction(list => {
      for (const c of list) {
        upsertCo.run(c.id, c.name || '', c.email || '', c.address_city || '', started);
      }
    });
    insertAllCo(companies);
    console.log(`[SYNC] ${companies.length} entreprises`);

    // 2. Projets
    console.log('[SYNC] Chargement projets…');
    const projects = await axoAll('/api/v2/projects');
    const upsertPrj = db.prepare(`
      INSERT INTO projects (id, company_id, name, actual_hours)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET company_id=excluded.company_id,
        name=excluded.name, actual_hours=excluded.actual_hours
    `);
    const insertAllPrj = db.transaction(list => {
      for (const p of list) {
        upsertPrj.run(p.id, p.company_id, p.name || '', p.actual_hours || 0);
      }
    });
    insertAllPrj(projects);
    console.log(`[SYNC] ${projects.length} projets`);

    // 3. Factures → contrats EVO
    console.log('[SYNC] Chargement factures…');
    const invoices = await axoAll('/api/v2/invoices');
    db.prepare('DELETE FROM contracts').run();
    const insertCtr = db.prepare(`
      INSERT INTO contracts (company_id, invoice_num, invoice_date, product_id, label, hours, qty)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAllCtr = db.transaction(list => {
      for (const inv of list) {
        const cid = inv.company ? inv.company.id : null;
        if (!cid) continue;
        for (const ln of (inv.invoice_lines || [])) {
          const pid = Number(ln.product_id);
          if (!EVO_IDS.includes(pid)) continue;
          insertCtr.run(
            cid,
            inv.number || String(inv.id),
            inv.date || '',
            pid,
            EVO_LABELS[pid],
            EVO_HOURS[pid] * (ln.quantity || 1),
            ln.quantity || 1
          );
        }
      }
    });
    insertAllCtr(invoices);
    console.log(`[SYNC] Contrats EVO extraits`);

    // 4. Tickets + timetrackings
    console.log('[SYNC] Chargement tickets…');
    const tickets = await axoAll('/api/v2/tickets');

    // Index projets EVO/Assistance
    const evoProjects = new Map();
    for (const p of projects) {
      const n = (p.name || '').toLowerCase();
      if (n.includes('evo') || n.includes('assistance')) {
        evoProjects.set(p.id, p.name);
      }
    }

    const relTickets = tickets.filter(t => t.project_id && evoProjects.has(t.project_id));
    console.log(`[SYNC] ${relTickets.length} tickets EVO/Assistance à synchroniser`);

    // Timetrackings par batch de 10
    const upsertTix = db.prepare(`
      INSERT INTO tickets (id, company_id, project_id, project_name, title, reference, is_closed, creation_date, hours)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET hours=excluded.hours, is_closed=excluded.is_closed,
        project_name=excluded.project_name
    `);

    for (let i = 0; i < relTickets.length; i += 10) {
      const batch = relTickets.slice(i, i + 10);
      await Promise.all(batch.map(async t => {
        try {
          const tts = await axoAll('/api/v2/tickets/' + t.id + '/timetrackings');
          const hours = tts.reduce((s, tt) => s + parseFloat(tt.hours || 0), 0);
          upsertTix.run(
            t.id, t.company_id, t.project_id,
            evoProjects.get(t.project_id) || '',
            t.title || '', t.reference || '',
            t.is_closed ? 1 : 0,
            t.creation_date || '',
            hours
          );
        } catch(e) {
          console.error('[SYNC] Erreur ticket', t.id, e.message);
        }
      }));
      if (i % 50 === 0) console.log(`[SYNC] Tickets : ${Math.min(i+10, relTickets.length)}/${relTickets.length}`);
    }

    const finished = Math.floor(Date.now() / 1000);
    db.prepare('INSERT INTO sync_log (started_at, finished_at, status, message) VALUES (?,?,?,?)')
      .run(started, finished, 'ok', `${companies.length} clients, ${relTickets.length} tickets`);

    syncRunning = false;
    console.log('[SYNC] Terminé ✅');
    return { ok: true, message: 'Sync terminée' };

  } catch(e) {
    syncRunning = false;
    db.prepare('INSERT INTO sync_log (started_at, finished_at, status, message) VALUES (?,?,?,?)')
      .run(started, Math.floor(Date.now() / 1000), 'error', e.message);
    console.error('[SYNC] Erreur :', e.message);
    return { ok: false, message: e.message };
  }
}

// Sync au démarrage (non bloquant)
setTimeout(() => syncAll(), 2000);

// ── HELPERS HTTP ─────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '';
}

function parseQueryString(url) {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  return Object.fromEntries(new URLSearchParams(url.slice(idx + 1)));
}

// ── AUTH ADMIN ───────────────────────────────────────────
function createAdminSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?,?,?)')
    .run(token, now, now + 86400 * 7); // 7 jours
  return token;
}

function checkAdminSession(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/admin_token=([a-f0-9]+)/);
  if (!match) return false;
  const session = db.prepare('SELECT * FROM admin_sessions WHERE token=? AND expires_at>?')
    .get(match[1], Math.floor(Date.now() / 1000));
  return !!session;
}

// ── DONNÉES CLIENT ───────────────────────────────────────
function getClientData(companyId) {
  const company   = db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
  const contracts = db.prepare('SELECT * FROM contracts WHERE company_id=? ORDER BY invoice_date ASC').all(companyId);
  const tickets   = db.prepare('SELECT * FROM tickets WHERE company_id=? ORDER BY creation_date DESC').all(companyId);
  const evoPrj    = db.prepare("SELECT * FROM projects WHERE company_id=? AND lower(name) LIKE '%evo%'").all(companyId);
  const assistPrj = db.prepare("SELECT * FROM projects WHERE company_id=? AND lower(name) LIKE '%assistance%'").all(companyId);

  const soldH   = contracts.reduce((s, c) => s + c.hours, 0);
  const evoTix  = tickets.filter(t => t.project_name && t.project_name.toLowerCase().includes('evo'));
  const usedH   = evoTix.reduce((s, t) => s + t.hours, 0);
  const remH    = Math.max(0, soldH - usedH);
  const pct     = soldH > 0 ? Math.min(100, Math.round((usedH / soldH) * 100)) : 0;

  return { company, contracts, tickets, evoPrj, assistPrj, soldH, usedH, remH, pct, evoTix };
}

// ── SERVEUR HTTP ─────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.ico':  'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url    = req.url.split('?')[0];
  const query  = parseQueryString(req.url);
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── API ROUTES ──────────────────────────────────────────

  // POST /api/auth/admin — login admin
  if (method === 'POST' && url === '/api/auth/admin') {
    const body = await readBody(req);
    if (body.password === ADMIN_PASS) {
      const token = createAdminSession();
      res.setHeader('Set-Cookie', `admin_token=${token}; HttpOnly; Path=/; Max-Age=${86400*7}; SameSite=Strict`);
      return json(res, 200, { ok: true });
    }
    return json(res, 401, { ok: false, error: 'Mot de passe incorrect' });
  }

  // POST /api/auth/logout
  if (method === 'POST' && url === '/api/auth/logout') {
    res.setHeader('Set-Cookie', 'admin_token=; HttpOnly; Path=/; Max-Age=0');
    return json(res, 200, { ok: true });
  }

  // POST /api/auth/request-otp — client demande un OTP
  if (method === 'POST' && url === '/api/auth/request-otp') {
    const body = await readBody(req);
    const { company_id, email } = body;
    if (!company_id || !email) return json(res, 400, { error: 'Données manquantes' });

    // Vérifier que l'email correspond au client dans la BDD
    const company = db.prepare('SELECT * FROM companies WHERE id=?').get(company_id);
    if (!company) return json(res, 404, { error: 'Client introuvable' });

    // Vérifier l'email dans Axonaut (employees)
    const { body: empData } = await axoGet('/api/v2/companies/' + company_id + '/employees', 1);
    const employees = Array.isArray(empData) ? empData : [];
    const emailMatch = employees.some(e => (e.email || '').toLowerCase() === email.toLowerCase())
      || (company.email || '').toLowerCase() === email.toLowerCase();

    if (!emailMatch) return json(res, 403, { error: 'Email non reconnu pour ce client' });

    // Générer OTP
    const code    = String(Math.floor(100000 + Math.random() * 900000));
    const token   = crypto.randomBytes(32).toString('hex');
    const expires = Math.floor(Date.now() / 1000) + 900; // 15 min

    db.prepare('INSERT INTO otp_sessions (token, company_id, email, code, expires_at) VALUES (?,?,?,?,?)')
      .run(token, company_id, email.toLowerCase(), code, expires);

    // Envoyer email
    try {
      await mailer.sendMail({
        from: `"Equinoxes" <${process.env.SMTP_USER}>`,
        to: email,
        subject: 'Votre code de connexion EVO — Equinoxes',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
            <h2 style="color:#222339">Votre code de connexion</h2>
            <p>Bonjour,</p>
            <p>Voici votre code pour accéder à votre espace EVO :</p>
            <div style="background:#f4f5f8;border-radius:8px;padding:24px;text-align:center;margin:24px 0">
              <span style="font-size:2.5rem;font-weight:bold;letter-spacing:8px;color:#222339">${code}</span>
            </div>
            <p style="color:#666;font-size:14px">Ce code est valable <strong>15 minutes</strong>.<br>Si vous n'avez pas demandé ce code, ignorez cet email.</p>
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
            <p style="color:#999;font-size:12px">Equinoxes · Agence web & communication · Reims</p>
          </div>`,
      });
    } catch(e) {
      console.error('[OTP] Erreur envoi email :', e.message);
      return json(res, 500, { error: 'Erreur envoi email : ' + e.message });
    }

    return json(res, 200, { ok: true, token });
  }

  // POST /api/auth/verify-otp — client vérifie son code
  if (method === 'POST' && url === '/api/auth/verify-otp') {
    const body = await readBody(req);
    const { token, code } = body;
    if (!token || !code) return json(res, 400, { error: 'Données manquantes' });

    const session = db.prepare('SELECT * FROM otp_sessions WHERE token=? AND expires_at>?')
      .get(token, Math.floor(Date.now() / 1000));

    if (!session) return json(res, 401, { error: 'Session expirée ou invalide' });
    if (session.code !== String(code)) return json(res, 401, { error: 'Code incorrect' });

    // Marquer comme vérifié
    db.prepare('UPDATE otp_sessions SET verified=1 WHERE token=?').run(token);

    // Logger la connexion
    const company = db.prepare('SELECT * FROM companies WHERE id=?').get(session.company_id);
    db.prepare('INSERT INTO client_logs (company_id, company_name, email, ip) VALUES (?,?,?,?)')
      .run(session.company_id, company?.name || '', session.email, getIP(req));

    // Cookie client
    res.setHeader('Set-Cookie', `client_token=${token}; HttpOnly; Path=/; Max-Age=${86400}; SameSite=Strict`);
    return json(res, 200, { ok: true, company_id: session.company_id });
  }

  // GET /api/client/me — données client authentifié
  if (method === 'GET' && url === '/api/client/me') {
    const cookie = req.headers.cookie || '';
    const match  = cookie.match(/client_token=([a-f0-9]+)/);
    if (!match) return json(res, 401, { error: 'Non authentifié' });

    const session = db.prepare('SELECT * FROM otp_sessions WHERE token=? AND verified=1 AND expires_at>?')
      .get(match[1], Math.floor(Date.now() / 1000));
    if (!session) return json(res, 401, { error: 'Session expirée' });

    const data = getClientData(session.company_id);
    return json(res, 200, { ...data, links: LINKS });
  }

  // GET /api/admin/search?q= — recherche client (admin)
  if (method === 'GET' && url === '/api/admin/search') {
    if (!checkAdminSession(req)) return json(res, 401, { error: 'Non authentifié' });
    const q = (query.q || '').toLowerCase();
    const results = db.prepare("SELECT id,name,email,city FROM companies WHERE lower(name) LIKE ? LIMIT 10")
      .all(`%${q}%`);
    return json(res, 200, results);
  }

  // GET /api/admin/client/:id — détail client (admin)
  if (method === 'GET' && url.startsWith('/api/admin/client/')) {
    if (!checkAdminSession(req)) return json(res, 401, { error: 'Non authentifié' });
    const id = parseInt(url.split('/').pop());
    return json(res, 200, getClientData(id));
  }

  // GET /api/admin/alerts — clients dépassés 100%
  if (method === 'GET' && url === '/api/admin/alerts') {
    if (!checkAdminSession(req)) return json(res, 401, { error: 'Non authentifié' });

    const companies = db.prepare('SELECT DISTINCT company_id FROM contracts').all();
    const alerts = [];
    for (const { company_id } of companies) {
      const d = getClientData(company_id);
      if (d.pct >= 100 && d.soldH > 0) {
        alerts.push({
          id: company_id,
          name: d.company?.name || '',
          soldH: d.soldH,
          usedH: d.usedH,
          pct: d.pct,
          overH: Math.max(0, d.usedH - d.soldH),
        });
      }
    }
    alerts.sort((a, b) => b.pct - a.pct);
    return json(res, 200, alerts);
  }

  // GET /api/admin/logs — logs connexions clients
  if (method === 'GET' && url === '/api/admin/logs') {
    if (!checkAdminSession(req)) return json(res, 401, { error: 'Non authentifié' });
    const logs = db.prepare('SELECT * FROM client_logs ORDER BY logged_at DESC LIMIT 100').all();
    return json(res, 200, logs);
  }

  // GET /api/admin/sync-status
  if (method === 'GET' && url === '/api/admin/sync-status') {
    if (!checkAdminSession(req)) return json(res, 401, { error: 'Non authentifié' });
    const last = db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 1').get();
    const counts = {
      companies: db.prepare('SELECT COUNT(*) as n FROM companies').get().n,
      tickets:   db.prepare('SELECT COUNT(*) as n FROM tickets').get().n,
      contracts: db.prepare('SELECT COUNT(*) as n FROM contracts').get().n,
    };
    return json(res, 200, { last, counts, running: syncRunning });
  }

  // POST /api/admin/sync — lancer sync manuellement
  if (method === 'POST' && url === '/api/admin/sync') {
    if (!checkAdminSession(req)) return json(res, 401, { error: 'Non authentifié' });
    syncAll(); // non bloquant
    return json(res, 200, { ok: true, message: 'Sync lancée en arrière-plan' });
  }

  // GET /api/auth/check — vérifie si admin connecté
  if (method === 'GET' && url === '/api/auth/check') {
    return json(res, 200, { admin: checkAdminSession(req) });
  }

  // ── FICHIERS STATIQUES ──────────────────────────────────
  let filePath = path.join(__dirname, 'public',
    url === '/' || url === '/client' ? 'index.html' : url
  );

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (err2, data2) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(data2);
      });
      return;
    }
    const mime = MIME[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🟢  EVO Dashboard v2 — port ${PORT}\n`);
});
