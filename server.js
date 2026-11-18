// ================================================================
//  P&L Dashboard — servidor Node (reemplaza a Code.gs de Apps Script)
//  Sirve la página y actúa de proxy hacia Oracle PBCS.
//
//  Cada función que antes se llamaba con google.script.run.X(...) ahora
//  es POST {BASE_PATH}/api/rpc/X  con body { args: [...] }.
//  El archivo public/gas-shim.js hace esa traducción en el navegador,
//  así que index.html no necesita cambios.
// ================================================================

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');

// ── Configuración / secretos ─────────────────────────────────────
// En Ownia los secretos llegan como JSON en APP_SECRETS. Para correrlo
// localmente también se aceptan como variables de entorno sueltas.
const SECRETS = (() => {
  try { return JSON.parse(process.env.APP_SECRETS || '{}'); } catch (e) { return {}; }
})();
const secret = (k) => SECRETS[k] || process.env[k] || '';

const PORT      = process.env.PORT || 8080;
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');
const TIMEZONE  = 'America/Argentina/Buenos_Aires';

const PBCS_BASE    = 'https://epmdespegaropsfin2-despegaroraclesaas.epm.us-phoenix-1.ocs.oraclecloud.com';
const PBCS_URL     = PBCS_BASE + '/HyperionPlanning/rest/v3/applications/PPTO/plantypes/PPTO/exportdataslice';
const PBCS_INTEROP = PBCS_BASE + '/interop/rest/11.1.2.3.600';
const PBCS_TIMEOUT_MS = 5 * 60 * 1000;

// Admins que pueden editar la configuración de Medidas.
// Se puede sobreescribir con el secreto ADMIN_EMAILS (lista separada por comas).
const ALERT_AUTHORIZED_EMAILS = (secret('ADMIN_EMAILS')
  ? secret('ADMIN_EMAILS').split(',')
  : [
      'joaquin.cassiani@despegar.com',
      'juan.chahwan@despegar.com',
      'agustin.troglio@despegar.com',
      'micaela.kennis@despegar.com',
    ]).map((e) => e.toLowerCase().trim()).filter(Boolean);

const VALID_FISCAL_MONTHS = ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar'];
const MEDIDAS_DEFAULT = { actualMonths: ['Apr','May'], runRateMonths: [], runRateTail: 'Forecast', forecastActualMonths: ['Apr','May'] };

// ── Identidad del usuario: login con Google, solo cuentas Despegar ──
// Reemplaza a Session.getActiveUser().getEmail() y a la restricción de dominio
// de la web app de Apps Script. Usa el proxy de Google de Ownia (sin configurar
// nada en Google Cloud): el usuario conecta su cuenta, leemos su email y, si es
// de un dominio permitido, le damos una cookie de sesión firmada.
const ALLOWED_DOMAINS = (secret('ALLOWED_EMAIL_DOMAINS') || 'despegar.com')
  .split(',').map((d) => d.toLowerCase().trim()).filter(Boolean);
const APP_NAME     = secret('APP_NAME') || BASE_PATH.replace(/^\//, '');
const PROXY_SECRET = secret('GOOGLE_PROXY_APP_SECRET');
const PROXY_URL    = (secret('GOOGLE_PROXY_INTERNAL_URL') || process.env.MCP_RESOURCE_URL || '').replace(/\/+$/, '');
const SESSION_KEY  = crypto.createHash('sha256')
  .update('pnl-session:' + (secret('SESSION_SECRET') || PROXY_SECRET || crypto.randomBytes(32).toString('hex')))
  .digest();
const SESSION_COOKIE = 'pnl_session';
const PENDING_COOKIE = 'pnl_login';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PENDING_TTL_MS = 15 * 60 * 1000;
const COOKIE_PATH    = BASE_PATH || '/';

function sign(obj) {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const mac  = crypto.createHmac('sha256', SESSION_KEY).update(body).digest('base64url');
  return body + '.' + mac;
}

function verify(token) {
  if (!token) return null;
  const [body, mac] = String(token).split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', SESSION_KEY).update(body).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return obj && obj.exp && obj.exp > Date.now() ? obj : null;
  } catch (e) { return null; }
}

function readCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { /* cookie inválida */ }
    }
  });
  return out;
}

function setCookie(res, name, value, maxAgeMs) {
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`);
}

function clearCookie(res, name) {
  res.append('Set-Cookie', `${name}=; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

function emailAllowed(email) {
  const domain = (String(email).split('@')[1] || '').toLowerCase();
  return ALLOWED_DOMAINS.includes(domain);
}

function getUserEmail(req) {
  // Solo para correrlo local sin el proxy de Google (en Ownia el proxy siempre está)
  if (!PROXY_SECRET && process.env.DEV_USER_EMAIL) return process.env.DEV_USER_EMAIL.toLowerCase();
  const session = verify(readCookies(req)[SESSION_COOKIE]);
  return session && session.email && emailAllowed(session.email) ? session.email : '';
}

// URL pública de la app (siempre https: Ownia la sirve detrás de HTTPS)
function publicUrl(req, p) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `https://${host}${BASE_PATH}${p}`;
}

async function proxyFetch(p, init = {}) {
  if (!PROXY_URL || !PROXY_SECRET) {
    throw new Error('El login con Google no está configurado (faltan GOOGLE_PROXY_* en APP_SECRETS).');
  }
  const res = await fetch(PROXY_URL + p, {
    ...init,
    headers: { ...(init.headers || {}), 'X-Ownia-App-Secret': PROXY_SECRET },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google proxy HTTP ${res.status}: ${text.substring(0, 200)}`);
  try { return JSON.parse(text); } catch (e) { throw new Error('Respuesta no JSON del proxy de Google.'); }
}

// Averigua el email de la cuenta de Google que se acaba de conectar
async function lookupGoogleEmail(uid) {
  const q = `app_name=${encodeURIComponent(APP_NAME)}&external_user_id=${encodeURIComponent(uid)}`;
  const attempts = [
    ['/google/proxy/drive/v3/about?fields=user&' + q,      (d) => d && d.user && d.user.emailAddress],
    ['/google/proxy/gmail/v1/users/me/profile?' + q,       (d) => d && d.emailAddress],
    ['/google/proxy/calendar/v3/calendars/primary?' + q,   (d) => d && d.id],
  ];
  for (const [p, pick] of attempts) {
    try {
      const email = pick(await proxyFetch(p));
      if (email && String(email).includes('@')) return String(email).toLowerCase();
    } catch (e) {
      console.warn('[login] no se pudo leer el email:', e.message);
    }
  }
  return '';
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function messagePage(title, detailHtml) {
  return '<!doctype html><html lang="es"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1"><title>EPM Hub · P&amp;L</title>'
    + '<style>body{font-family:system-ui,sans-serif;background:#F4F6FA;color:#0B1220;display:flex;'
    + 'align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px}'
    + '.card{background:#fff;border:1px solid #E5E7EB;border-radius:14px;padding:28px;max-width:440px}'
    + 'h1{font-size:17px;margin:0 0 10px}p{font-size:14px;color:#374151;line-height:1.5;margin:0}a{color:#5B5BF5}</style>'
    + '</head><body><div class="card"><h1>' + escHtml(title) + '</h1><p>' + detailHtml + '</p></div></body></html>';
}

function isAdmin(email) {
  return !!email && ALERT_AUTHORIZED_EMAILS.includes(email.toLowerCase().trim());
}

// ── Almacenamiento (reemplaza a PropertiesService) ───────────────
// En Ownia usa DynamoDB (tabla y claves vienen en APP_SECRETS).
// Si no hay tabla configurada (ej. corriendo local) guarda en memoria.
const TABLE = secret('DYNAMODB_TABLE');
const PK    = secret('DYNAMODB_PK') || 'pk';
const SK    = secret('DYNAMODB_SK') || 'sk';
const ddb   = TABLE ? DynamoDBDocumentClient.from(new DynamoDBClient({})) : null;
const memStore = new Map();

async function getItem(pk, sk) {
  if (!ddb) return memStore.get(pk + '|' + sk) || null;
  const out = await ddb.send(new GetCommand({ TableName: TABLE, Key: { [PK]: pk, [SK]: sk } }));
  return out.Item || null;
}

async function putItem(pk, sk, attrs) {
  const item = { ...attrs, [PK]: pk, [SK]: sk };
  if (!ddb) { memStore.set(pk + '|' + sk, item); return; }
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
}

// ── Helper PBCS ──────────────────────────────────────────────────
async function pbcsFetch(url, { method = 'GET', headers = {}, body } = {}) {
  const user = secret('PBCS_USER');
  const pass = secret('PBCS_PASSWORD');
  if (!user || !pass) {
    throw new Error('Faltan las credenciales de PBCS (PBCS_USER / PBCS_PASSWORD) en los secretos de la app.');
  }
  const res = await fetch(url, {
    method,
    headers: { ...headers, Authorization: 'Basic ' + Buffer.from(user + ':' + pass).toString('base64') },
    body,
    signal: AbortSignal.timeout(PBCS_TIMEOUT_MS),
  });
  if (res.status >= 400) {
    const text = await res.text().catch(() => '');
    throw new Error('PBCS HTTP ' + res.status + ': ' + text.substring(0, 300));
  }
  return res;
}

async function downloadSnapshot(filename) {
  const url = PBCS_INTEROP + '/applicationsnapshots/' + encodeURIComponent(filename) + '/contents';
  const res = await pbcsFetch(url, { headers: { Accept: 'application/octet-stream,*/*' } });
  return Buffer.from(await res.arrayBuffer());
}

function formatTimestamp(d) {
  // yyyy-MM-dd HH:mm:ss en la zona horaria de Argentina
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}:${parts.second}`;
}

// ── Funciones expuestas al navegador (mismo nombre que en Code.gs) ──
// Cada una recibe (ctx, ...args) donde ctx = { email }.
const RPC = {
  // Proxy hacia Oracle PBCS (data slice)
  async fetchPBCS(ctx, payloadStr) {
    const res = await pbcsFetch(PBCS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: payloadStr,
    });
    return await res.text();
  },

  // Dispara el job de export
  async runExportJob(ctx, jobName) {
    jobName = jobName || 'Actual FCCS';
    const res = await pbcsFetch(PBCS_BASE + '/HyperionPlanning/rest/v3/applications/PPTO/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jobType: 'EXPORT_DATA', jobName }),
    });
    return await res.text(); // JSON string con jobId
  },

  // Estado del job
  async getJobStatus(ctx, jobId) {
    const res = await pbcsFetch(
      PBCS_BASE + '/HyperionPlanning/rest/v3/applications/PPTO/jobs/' + encodeURIComponent(jobId),
      { headers: { Accept: 'application/json' } }
    );
    return await res.text();
  },

  // Descarga un archivo del outbox y lo devuelve como base64
  async downloadExportFile(ctx, filename) {
    const buf = await downloadSnapshot(filename);
    return JSON.stringify({ filename, base64: buf.toString('base64') });
  },

  // Descarga varios archivos y los combina en un ZIP
  async downloadExportFilesZipped(ctx, filenames, zipName) {
    zipName = zipName || 'export.zip';
    const buffers = await Promise.all((filenames || []).map(downloadSnapshot));
    const zip = new AdmZip();
    buffers.forEach((buf, i) => zip.addFile(filenames[i], buf));
    return JSON.stringify({ filename: zipName, base64: zip.toBuffer().toString('base64') });
  },

  // Log de Refresh (antes iba a una Google Sheet; ahora a la base de la app y a los logs)
  async logRefresh(ctx, vista) {
    try {
      const now = new Date();
      const timestamp = formatTimestamp(now);
      console.log(JSON.stringify({ event: 'refresh', timestamp, usuario: ctx.email, vista }));
      await putItem('refreshlog#' + timestamp.substring(0, 7), now.toISOString() + '#' + Math.random().toString(36).slice(2, 8), {
        timestamp, usuario: ctx.email, vista: String(vista || ''),
      });
    } catch (e) {
      // silencioso — nunca bloquea el refresh principal
    }
    return null;
  },

  isAuthorizedForAlerts(ctx) {
    return isAdmin(ctx.email);
  },

  // Lectura: pública
  async getMedidasConfig() {
    try {
      const item = await getItem('config', 'medidas');
      if (item && item.value) return JSON.parse(item.value);
    } catch (e) {
      console.warn('getMedidasConfig falló, se usa el default:', e.message);
    }
    return JSON.parse(JSON.stringify(MEDIDAS_DEFAULT));
  },

  // Escritura: solo admins
  async setMedidasConfig(ctx, config) {
    if (!isAdmin(ctx.email)) throw new Error('Usuario no autorizado para editar esta configuración.');
    config = config || {};
    const valid = VALID_FISCAL_MONTHS;
    const tailOpts = ['Forecast', 'Budget', 'None'];
    const onlyValid = (arr) => (arr || []).filter((m) => valid.includes(m));
    const clean = {
      actualMonths:         onlyValid(config.actualMonths),
      runRateMonths:        onlyValid(config.runRateMonths),
      runRateTail:          tailOpts.includes(config.runRateTail) ? config.runRateTail : 'Forecast',
      forecastActualMonths: onlyValid(config.forecastActualMonths),
    };
    await putItem('config', 'medidas', {
      value: JSON.stringify(clean), updatedBy: ctx.email, updatedAt: new Date().toISOString(),
    });
    return { ok: true, config: clean };
  },

  // Info del usuario: email e isAdmin
  getUserInfo(ctx) {
    return { email: ctx.email, isAdmin: isAdmin(ctx.email) };
  },

  // Legacy
  async getActualMonthsConfig(ctx) {
    return (await RPC.getMedidasConfig(ctx)).actualMonths;
  },
  async setActualMonthsConfig(ctx, monthsArray) {
    return RPC.setMedidasConfig(ctx, { actualMonths: monthsArray, runRateMonths: [], runRateTail: 'Forecast' });
  },

  // El HTML la referencia pero no existía en Code.gs
  sendDeviationAlert() {
    throw new Error('El envío a Slack todavía no está implementado.');
  },
};

// ── Página ───────────────────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');

function renderIndex() {
  if (!fs.existsSync(INDEX_FILE)) {
    return '<!doctype html><meta charset="utf-8"><p>Falta public/index.html</p>';
  }
  const html = fs.readFileSync(INDEX_FILE, 'utf8');
  // Inyecta el shim que reemplaza a google.script.run, antes de cualquier script de la página
  const shim = '<script src="gas-shim.js"></script>';
  return html.includes('</head>') ? html.replace('</head>', shim + '\n</head>') : shim + html;
}
const INDEX_HTML = renderIndex();

// ── Rutas ────────────────────────────────────────────────────────
const router = express.Router();
router.use(express.json({ limit: '20mb' }));

router.get('/health', (req, res) => res.json({ ok: true }));

// ── Login ────────────────────────────────────────────────────────
router.get('/login', async (req, res) => {
  try {
    const uid = 'login-' + crypto.randomUUID();
    const data = await proxyFetch('/google/connect-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_name: APP_NAME, external_user_id: uid, next: publicUrl(req, '/auth/callback') }),
    });
    if (!data || !data.connect_url) throw new Error('El proxy de Google no devolvió connect_url.');
    setCookie(res, PENDING_COOKIE, sign({ uid, exp: Date.now() + PENDING_TTL_MS }), PENDING_TTL_MS);
    res.redirect(302, data.connect_url);
  } catch (e) {
    console.error('[login]', e.message);
    res.status(500).type('html').send(messagePage('No se pudo iniciar el login con Google.', escHtml(e.message)));
  }
});

router.get('/auth/callback', async (req, res) => {
  const pending = verify(readCookies(req)[PENDING_COOKIE]);
  clearCookie(res, PENDING_COOKIE);
  const retry = '<a href="' + escHtml(publicUrl(req, '/login')) + '">';
  if (!pending || !pending.uid) return res.redirect(302, publicUrl(req, '/login'));

  const email = await lookupGoogleEmail(pending.uid);
  if (!email) {
    return res.status(403).type('html').send(messagePage('No pudimos verificar tu cuenta de Google.', retry + 'Probar de nuevo</a>'));
  }
  if (!emailAllowed(email)) {
    console.warn('[login] acceso rechazado para', email);
    return res.status(403).type('html').send(messagePage('Acceso solo para cuentas de Despegar.',
      'Entraste con ' + escHtml(email) + '. ' + retry + 'Entrar con otra cuenta</a>'));
  }
  console.log(JSON.stringify({ event: 'login', email }));
  setCookie(res, SESSION_COOKIE, sign({ email, exp: Date.now() + SESSION_TTL_MS }), SESSION_TTL_MS);
  res.redirect(302, publicUrl(req, '/'));
});

router.get('/logout', (req, res) => {
  clearCookie(res, SESSION_COOKIE);
  res.type('html').send(messagePage('Sesión cerrada.', '<a href="' + escHtml(publicUrl(req, '/login')) + '">Volver a entrar</a>'));
});

// ── Página (requiere login) ──────────────────────────────────────
router.get(['/', '/index.html'], (req, res) => {
  // La página arma las URLs de la API relativas a su propia ruta,
  // así que necesita terminar en "/" (ej. /mi-app/ y no /mi-app).
  const [p, qs] = req.originalUrl.split('?');
  if (!p.endsWith('/') && !p.endsWith('.html')) {
    return res.redirect(301, p + '/' + (qs ? '?' + qs : ''));
  }
  if (!getUserEmail(req)) return res.redirect(302, publicUrl(req, '/login'));
  res.set('Cache-Control', 'no-store');
  res.type('html').send(INDEX_HTML);
});

router.use(express.static(PUBLIC_DIR, { index: false }));

// ── API (requiere login) ─────────────────────────────────────────
router.post('/api/rpc/:fn', async (req, res) => {
  const name = req.params.fn;
  const email = getUserEmail(req);
  if (!email) return res.status(401).json({ error: 'Tu sesión expiró. Volvé a entrar.', login: true });
  if (!Object.prototype.hasOwnProperty.call(RPC, name)) {
    return res.status(404).json({ error: 'Función desconocida: ' + name });
  }
  const args = Array.isArray(req.body && req.body.args) ? req.body.args : [];
  const ctx = { email };
  try {
    const result = await RPC[name](ctx, ...args);
    res.json({ result: result === undefined ? null : result });
  } catch (e) {
    console.error('[rpc ' + name + ']', e.message);
    res.status(500).json({ error: e.message || String(e) });
  }
});

const app = express();
app.disable('x-powered-by');
if (BASE_PATH) app.use(BASE_PATH, router);
app.use('/', router); // por si el proxy ya le saca el prefijo a la ruta

app.listen(PORT, () => {
  console.log(`P&L Dashboard escuchando en :${PORT} (BASE_PATH="${BASE_PATH}", storage=${ddb ? 'dynamodb' : 'memoria'})`);
});
