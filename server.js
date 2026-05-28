/**
 * Equinoxes EVO Dashboard — server.js
 * -------------------------------------
 * - Sert le dashboard HTML (public/index.html)
 * - Proxifie les appels vers l'API Axonaut sur /api/*
 *   en injectant la clé depuis la variable d'env AXONAUT_API_KEY
 *
 * Variables d'environnement (à définir dans Coolify) :
 *   AXONAUT_API_KEY  — votre clé API Axonaut
 *   PORT             — port d'écoute (défaut : 3000)
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT    = process.env.PORT || 3000;
const API_KEY = process.env.AXONAUT_API_KEY || '';

if (!API_KEY) {
  console.warn('⚠  AXONAUT_API_KEY non définie — les appels API échoueront.');
}

// ── MIME types basiques ──
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

const server = http.createServer((req, res) => {

  // ── CORS (pour dev local éventuel) ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  // ── Proxy API Axonaut : /api/* → https://axonaut.com/api/* ──
  if (req.url.startsWith('/api/')) {
    if (!API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'AXONAUT_API_KEY non configurée sur le serveur.' }));
      return;
    }

    const targetPath = req.url; // conserve query string
    console.log(`[PROXY] ${req.method} https://axonaut.com${targetPath}`);

    const proxyReq = https.request({
      hostname: 'axonaut.com',
      port: 443,
      path: targetPath,
      method: req.method,
      headers: {
        'userApiKey':   API_KEY,
        'Content-Type': 'application/json',
        'Accept':       'application/json',
      }
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
      console.error('[PROXY ERROR]', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });

    req.pipe(proxyReq, { end: true });
    return;
  }

  // ── Fichiers statiques : public/ ──
  let filePath = path.join(__dirname, 'public',
    req.url === '/' ? 'index.html' : req.url
  );

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Fallback → index.html (SPA)
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (err2, data2) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(data2);
      });
      return;
    }
    const ext  = path.extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │  🟢  EVO Dashboard démarré                   │');
  console.log(`  │  Port : ${PORT}                                  │`);
  console.log(`  │  Clé API : ${API_KEY ? API_KEY.slice(0,4)+'••••••' : 'NON DÉFINIE ⚠'}           │`);
  console.log('  └──────────────────────────────────────────────┘');
  console.log('');
});
