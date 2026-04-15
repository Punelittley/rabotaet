require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const http = require('http');
const https = require('https');
const multer = require('multer');
const { Resend } = require('resend');

const resend = new Resend('re_BxZvQouu_AEfoC5GtNmeaaDQNzyJP5L6b');
const verificationCodes = new Map();
const VERIFY_CODE_TTL_MS = 15 * 60 * 1000;

const app = express();
app.set('trust proxy', true);
app.use(cookieParser());

/** ВК Callback: парсим тело как сырой JSON до express.json — иначе при «не тот» Content-Type body пустой и срабатывает проверка secret → 403 вместо строки подтверждения. */
function normalizeUrlPath(pathname) {
    if (!pathname) return '';
    const p = pathname.split('?')[0];
    if (p.length > 1) return p.replace(/\/+$/, '');
    return p;
}
const VK_CALLBACK_PATHS = ['/api/vk/callback', '/api/vk/callback/health'];

function isVkCallbackPost(req) {
    if (req.method !== 'POST') return false;
    const a = normalizeUrlPath(req.path || '');
    const b = normalizeUrlPath(req.originalUrl || req.url || '');
    return VK_CALLBACK_PATHS.includes(a) || VK_CALLBACK_PATHS.includes(b);
}
app.use((req, res, next) => {
    if (!isVkCallbackPost(req)) return next();
    return express.raw({ type: () => true, limit: '512kb', inflate: true })(req, res, (err) => {
        if (err) return next(err);
        const buf = req.body;
        const rawUtf8 = Buffer.isBuffer(buf) && buf.length ? buf.toString('utf8') : '';
        req._vkRawUtf8 = rawUtf8;
        try {
            const parsed = rawUtf8 ? JSON.parse(rawUtf8) : {};
            req.body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (e) {
            req.body = {};
            req._vkParseError = String(e.message || e);
        }
        next();
    });
});
app.use((req, res, next) => {
    if (isVkCallbackPost(req)) return next();
    express.json({
        limit: '100kb',
        verify: (req, res, buf) => {
            req._rawBody = buf;
        },
    })(req, res, next);
});
app.use(express.urlencoded({ extended: false }));

const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'public/uploads/');
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const SERVICES_FILE = path.join(DATA_DIR, 'services.json');
const SUPPORT_CHATS_FILE = path.join(DATA_DIR, 'support_chats.json');
const SUPPORT_BRIDGE_FILE = path.join(DATA_DIR, 'support_bridge.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]');
if (!fs.existsSync(SERVICES_FILE)) fs.writeFileSync(SERVICES_FILE, '[]');
if (!fs.existsSync(SUPPORT_CHATS_FILE)) fs.writeFileSync(SUPPORT_CHATS_FILE, '[]');
if (!fs.existsSync(SUPPORT_BRIDGE_FILE)) fs.writeFileSync(SUPPORT_BRIDGE_FILE, '{}');

const VK_GROUP_TOKEN = process.env.VK_GROUP_TOKEN || '';
const VK_CONFIRMATION_TOKEN = process.env.VK_CONFIRMATION_TOKEN || '';
const VK_CALLBACK_SECRET = process.env.VK_CALLBACK_SECRET || '';
const VK_SUPPORT_PEER_ID = Number(process.env.VK_SUPPORT_PEER_ID || 0);
/** Если задано — на confirmation проверяем, что group_id совпадает с сообществом (из JSON ВК). */
const VK_GROUP_ID = process.env.VK_GROUP_ID ? Number(process.env.VK_GROUP_ID) : 0;

let warnedVkNoToken = false;
let warnedVkNoPeer = false;

function readLocal(file) {
    try {
        const content = fs.readFileSync(file, 'utf8');
        return JSON.parse(content || '[]');
    } catch (e) { return []; }
}

function writeLocal(file, data) {
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch (e) { console.error('Local Write Error:', file, e.message); }
}

function readSupportChats() {
  const data = readLocal(SUPPORT_CHATS_FILE);
  return Array.isArray(data) ? data : [];
}

function writeSupportChats(chats) {
  writeLocal(SUPPORT_CHATS_FILE, Array.isArray(chats) ? chats : []);
}

function readSupportBridge() {
  try {
    const raw = fs.readFileSync(SUPPORT_BRIDGE_FILE, 'utf8');
    const data = JSON.parse(raw || '{}');
    return data && typeof data === 'object' ? data : {};
  } catch (_) {
    return {};
  }
}

function writeSupportBridge(data) {
  try {
    fs.writeFileSync(SUPPORT_BRIDGE_FILE, JSON.stringify(data || {}, null, 2));
  } catch (e) {
    console.error('Bridge write error:', e.message);
  }
}

function createMessage(from, text, source = 'site') {
  return {
    id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    from,
    text: String(text || '').trim(),
    source,
    time: new Date().toISOString(),
  };
}

function getOrCreateSupportChat(chats, sessionId, userLabel = 'Гость') {
  let chat = chats.find((c) => c.sessionId === sessionId);
  if (!chat) {
    chat = {
      sessionId,
      userLabel,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    };
    chats.push(chat);
  }
  return chat;
}

async function vkApi(method, payload = {}) {
  if (!VK_GROUP_TOKEN) {
    throw new Error('VK_GROUP_TOKEN is empty');
  }

  const url = new URL(`https://api.vk.com/method/${method}`);
  const params = {
    ...payload,
    access_token: VK_GROUP_TOKEN,
    v: '5.199',
  };

  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    url.searchParams.set(k, String(v));
  });

  const resp = await requestJson(url.toString(), { method: 'GET' });
  if (!resp.ok || resp.data?.error) {
    throw new Error(`VK API error: ${resp.text || JSON.stringify(resp.data || {})}`);
  }
  return resp.data?.response;
}

app.get('/admin.html', (req, res, next) => {
    if (req.cookies.access_level === 'root') {
        next();
    } else {
        res.status(404).send('<!DOCTYPE html><html><body><h1>404 Not Found</h1></body></html>');
    }
});

app.get('/favicon.ico', (req, res) => {
    const fav = path.join(__dirname, 'public', 'media', 'logo.svg');
    res.type('image/svg+xml');
    res.sendFile(fav);
});

/** VK Callback API — регистрируем до express.static, иначе запрос может уйти в раздачу файлов из public. */
app.get('/api/vk/callback', (req, res) => {
    res.status(200).type('text/plain; charset=utf-8').send(
        'VK callback: сервер отвечает. Подтверждение Callback — только POST с JSON (type=confirmation).'
    );
});

/** Диагностика без секретов: только GET. Адрес Callback в ВК должен быть /api/vk/callback (без /health). */
app.get('/api/vk/callback/health', (req, res) => {
    const code = String(VK_CONFIRMATION_TOKEN || '').trim().replace(/\s+/g, '');
    res.json({
        ok: true,
        hasConfirmationToken: Boolean(code),
        confirmationLength: code.length,
        hasCallbackSecret: Boolean(VK_CALLBACK_SECRET),
        callbackSecretLength: VK_CALLBACK_SECRET ? String(VK_CALLBACK_SECRET).length : 0,
        hasGroupToken: Boolean(VK_GROUP_TOKEN),
        groupIdFilter: VK_GROUP_ID || null,
        vkCallbackUrlHint:
            'В настройках Callback укажите …/api/vk/callback — не …/health. /health только для проверки в браузере.',
    });
});

function sendVkConfirmationString(res) {
    const code = String(VK_CONFIRMATION_TOKEN || '')
        .trim()
        .replace(/^\uFEFF/, '')
        .replace(/\s+/g, '');
    if (!code) {
        return false;
    }
    const buf = Buffer.from(code, 'utf8');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
    return true;
}

app.post(['/api/vk/callback', '/api/vk/callback/health'], async (req, res) => {
    try {
        const body =
            req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};

        const evtType = String(body.type ?? '').trim().toLowerCase();

        if (evtType === 'confirmation') {
            if (VK_CALLBACK_SECRET && body.secret != null && String(body.secret) !== String(VK_CALLBACK_SECRET)) {
                console.warn('[VK callback] confirmation: secret не совпадает с VK_CALLBACK_SECRET (.env и настройки Callback).');
                return res.status(403).type('text/plain').send('forbidden');
            }
            if (VK_GROUP_ID && Number(body.group_id) !== VK_GROUP_ID) {
                console.warn('[VK callback] confirmation: group_id', body.group_id, 'не совпадает с VK_GROUP_ID');
                return res.status(403).type('text/plain').send('forbidden');
            }
            if (!sendVkConfirmationString(res)) {
                console.error('[VK callback] VK_CONFIRMATION_TOKEN пуст — скопируйте строку из настроек Callback в .env');
                return res.status(500).type('text/plain').end();
            }
            console.log('[VK callback] confirmation ok, group_id=', body.group_id);
            return;
        }

        if (req._vkParseError) {
            console.error('[VK callback] JSON parse error:', req._vkParseError, 'raw_len=', (req._vkRawUtf8 || '').length);
        }
        if (!evtType && (req._vkRawUtf8 || '').length) {
            console.error('[VK callback] пустой type, начало тела:', (req._vkRawUtf8 || '').slice(0, 240));
        }

        if (VK_CALLBACK_SECRET && body.secret !== VK_CALLBACK_SECRET) {
            return res.status(403).send('forbidden');
        }

        if (body.type !== 'message_new') {
            return res.send('ok');
        }

        const vkMessage = body.object?.message || {};
        const text = String(vkMessage.text || '').trim();
        if (!text) return res.send('ok');

        const peerId = Number(vkMessage.peer_id || 0);
        const bridge = readSupportBridge();
        if (peerId && !Number(bridge.operatorPeerId || 0)) {
            bridge.operatorPeerId = peerId;
            bridge.autoBoundAt = new Date().toISOString();
            bridge.lastSessionByPeer = bridge.lastSessionByPeer || {};
            writeSupportBridge(bridge);
        }

        if (/^\/bind$/i.test(text) && peerId) {
            bridge.operatorPeerId = peerId;
            bridge.lastBoundAt = new Date().toISOString();
            bridge.lastSessionByPeer = bridge.lastSessionByPeer || {};
            writeSupportBridge(bridge);

            try {
                await vkApi('messages.send', {
                    peer_id: peerId,
                    random_id: Date.now(),
                    message: 'Чат поддержки привязан. Теперь сообщения с сайта будут приходить сюда.',
                });
            } catch (_) {}
            return res.send('ok');
        }

        const replyMatch = text.match(/^\/reply(?:@\w+)?\s+([A-Za-z0-9\-_]+)\s+([\s\S]{1,4000})$/i);
        const replyNoIdMatch = text.match(/^\/reply(?:@\w+)?\s+([\s\S]{1,4000})$/i);
        let sessionId = '';
        let answerText = '';

        if (replyMatch) {
            sessionId = replyMatch[1];
            answerText = replyMatch[2].trim();
        } else if (replyNoIdMatch) {
            answerText = replyNoIdMatch[1].trim();
            if (peerId && bridge.lastSessionByPeer?.[String(peerId)]) {
                sessionId = bridge.lastSessionByPeer[String(peerId)];
            } else if (bridge.lastSessionId) {
                sessionId = String(bridge.lastSessionId);
            }
        } else {
            const repliedText = String(vkMessage.reply_message?.text || '');
            const repliedMatch = repliedText.match(/\[Чат\s+([A-Za-z0-9\-_]+)\]/i);
            if (repliedMatch) {
                sessionId = repliedMatch[1];
                answerText = text;
            } else if (peerId && bridge.lastSessionByPeer?.[String(peerId)]) {
                sessionId = bridge.lastSessionByPeer[String(peerId)];
                answerText = text;
            }
        }

        if (!sessionId || !answerText) return res.send('ok');

        const chats = readSupportChats();
        const chat = getOrCreateSupportChat(chats, sessionId, 'Пользователь');
        chat.messages.push(createMessage('support', answerText, 'vk'));
        chat.updatedAt = new Date().toISOString();
        writeSupportChats(chats);

        if (peerId) {
            bridge.lastSessionByPeer = bridge.lastSessionByPeer || {};
            bridge.lastSessionByPeer[String(peerId)] = sessionId;
            bridge.lastSessionId = sessionId;
            writeSupportBridge(bridge);
        }

        return res.send('ok');
    } catch (e) {
        console.error('VK callback error:', e);
        return res.status(500).send('error');
    }
});

app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/admin/upload', upload.single('image'), (req, res) => {
    const hasRootCookie = req.cookies.access_level === 'root';
    if (!hasRootCookie) return res.status(403).json({ message: 'Forbidden' });

    if (!req.file) {
        return res.status(400).json({ message: 'No file uploaded' });
    }
    

    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({ url: fileUrl });
});

const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://ehklzcdkeezpuwclkeim.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || 'sb_publishable_BDHZJ9pKogGRkKcB2PYbHA_dAiieinS';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const REST_HEADERS = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  Accept: 'application/json',
};

const AUTH_HEADERS_ANON = {
  'Content-Type': 'application/json',
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  Accept: 'application/json',
};

const AUTH_HEADERS_SERVICE = SUPABASE_SERVICE_ROLE_KEY
  ? {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: 'application/json',
    }
  : null;

const CACHE_TTL_MS = 15000;
const cache = {};
const SIGNUP_DEFAULT_COOLDOWN_MS = 60000;
const signupCooldowns = new Map();


function cacheGet(key) {
  const hit = cache[key];
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) return null;
  return hit.data;
}

function cacheSet(key, data) {
  cache[key] = { data, ts: Date.now() };
  return data;
}

function setSignupCooldown(email, retryAfterMs) {
  if (!email) return;
  signupCooldowns.set(email, Date.now() + Math.max(1000, Number(retryAfterMs) || SIGNUP_DEFAULT_COOLDOWN_MS));
}

function normalizeEmail(v) {
  return String(v || '').trim().toLowerCase();
}

function parseRetryAfterMs(retryAfterHeader, fallbackMs) {
  const sec = Number(retryAfterHeader);
  if (Number.isFinite(sec) && sec > 0) return sec * 1000;
  return fallbackMs;
}

function extractAuthMessage(data, fallback) {
  return data?.error_description || data?.msg || data?.error || fallback;
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    return headers.get(name) || headers.get(String(name).toLowerCase());
  }
  const lower = String(name).toLowerCase();
  return headers[lower] || headers[name] || null;
}

async function requestJson(url, options = {}) {
  const method = options.method || 'GET';
  const headers = options.headers || {};
  const body = options.body;

  if (typeof globalThis.fetch === 'function') {
    const res = await fetch(url, { method, headers, body });
    const text = await res.text().catch(() => '');
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = text ? { raw: text } : {};
    }

    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      text,
      data,
    };
  }

  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;

    const req = transport.request(
      target,
      {
        method,
        headers,
      },
      (res) => {
        const chunks = [];

        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = {};
          try {
            data = text ? JSON.parse(text) : {};
          } catch {
            data = text ? { raw: text } : {};
          }

          resolve({
            ok: Number(res.statusCode) >= 200 && Number(res.statusCode) < 300,
            status: Number(res.statusCode) || 500,
            headers: res.headers || {},
            text,
            data,
          });
        });
      }
    );

    req.on('error', reject);

    if (body) req.write(body);
    req.end();
  });
}

async function supaGet(table, params = {}, customHeaders) {
  const base = `${SUPABASE_URL}/rest/v1/${table}`;
  const url = new URL(base);

  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    url.searchParams.set(k, String(v));
  });

  const res = await requestJson(url.toString(), {
    method: 'GET',
    headers: customHeaders || REST_HEADERS,
  });

  if (!res.ok) {
    throw new Error(`Supabase REST error: ${res.status} ${res.text || ''}`.trim());
  }

  return Array.isArray(res.data) ? res.data : [];
}

async function supaPost(table, body, customHeaders) {
  const res = await requestJson(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      ...(customHeaders || REST_HEADERS),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Supabase POST error: ${res.status} ${res.text || ''}`.trim());
  }

  return res.data;
}

async function supaPatch(table, id, body, customHeaders) {
  const res = await requestJson(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      ...(customHeaders || REST_HEADERS),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Supabase PATCH error: ${res.status} ${res.text || ''}`.trim());
  }

  return res.data;
}

async function supaDelete(table, id, customHeaders) {
    const res = await requestJson(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
      method: 'DELETE',
      headers: customHeaders || REST_HEADERS
    });
  
    if (!res.ok) {
      throw new Error(`Supabase DELETE error: ${res.status} ${res.text || ''}`.trim());
    }
  
    return res.data;
}

function getRestHeaders(accessToken = '') {
  if (accessToken) {
    return {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    };
  }

  if (AUTH_HEADERS_SERVICE) {
    return {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: 'application/json',
    };
  }

  return REST_HEADERS;
}

async function supaGetUser(accessToken) {
  return requestJson(`${SUPABASE_URL}/auth/v1/user`, {
    method: 'GET',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
}

async function supaAdminUpdateUser(userId, metadata) {
  return requestJson(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ user_metadata: metadata }),
  });
}

async function supaUpdateUserMetadata(accessToken, metadata) {
  return requestJson(`${SUPABASE_URL}/auth/v1/user`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
    body: JSON.stringify({ data: metadata }),
  });
}

function pickMeta(user) {
  const raw = user?.user_metadata || user?.raw_user_meta_data || {};

  const get = (...keys) => {
    for (const key of keys) {
      const value = raw?.[key];
      if (value === undefined || value === null) continue;
      const normalized = String(value).trim();
      if (normalized) return normalized;
    }
    return '';
  };

  return {
    name: get('name', 'firstName', 'first_name', 'given_name'),
    surname: get('surname', 'lastName', 'last_name', 'family_name'),
    organization: get('organization'),
    position: get('position'),
    phone: get('phone'),
    region: get('region'),
    inn: get('inn'),
    verified: raw?.verified === true || raw?.verified === 'true' || raw?.verified === 'VERIFIED',
  };
}

function mergeProfileIntoUser(user, profile) {
  if (!user) return user;

  const meta = pickMeta(user);
  const merged = {
    ...meta,
    ...(profile || {}),
    name: profile?.name || meta.name || '',
    surname: profile?.surname || meta.surname || '',
    organization: profile?.organization || meta.organization || '',
    position: profile?.position || meta.position || '',
    phone: profile?.phone || meta.phone || '',
    region: profile?.region || meta.region || '',
    inn: profile?.inn || meta.inn || '',
    verified: profile?.verified ?? meta.verified ?? false,
  };

  user.user_metadata = merged;
  return user;
}

async function getProfile(userId, accessToken = '') {
  try {
    const data = await supaGet(
      'profiles',
      {
        select: '*',
        user_id: `eq.${userId}`,
        limit: 1,
      },
      getRestHeaders(accessToken)
    );
    return Array.isArray(data) && data.length > 0 ? data[0] : null;
  } catch (e) {
    console.error('getProfile error:', e);
    return null;
  }
}

async function createProfile(profileData, accessToken = '') {
  // Use service role if no access token (admin mode)
  const headers = accessToken ? getRestHeaders(accessToken) : AUTH_HEADERS_SERVICE;
  return await supaPost('profiles', profileData, headers);
}

async function updateProfile(userId, profileData, accessToken = '') {
  const profile = await getProfile(userId, accessToken);
  if (profile?.id) {
    // Explicitly pick only allowed fields for table update
    const safeData = { updated_at: new Date().toISOString() };
    const allowed = ['name', 'surname', 'organization', 'position', 'phone', 'region', 'inn', 'verified', 'email'];
    allowed.forEach(f => { if (profileData[f] !== undefined) safeData[f] = profileData[f]; });

    const headers = accessToken ? getRestHeaders(accessToken) : AUTH_HEADERS_SERVICE;
    return await supaPatch('profiles', profile.id, safeData, headers);
  }
  return null;
}

async function ensureProfileForUser(user, accessToken = '', emailFallback = '') {
  if (!user?.id) return user;

  let profile = await getProfile(user.id, accessToken);

  if (!profile) {
    const meta = pickMeta(user);
    const now = new Date().toISOString();

    // Rock Solid construction of profile object with EXPLICIT keys
    const profileData = {
        user_id: user.id,
        email: user.email || emailFallback || '',
        name: meta.name || '',
        surname: meta.surname || '',
        organization: meta.organization || '',
        position: meta.position || '',
        phone: meta.phone || '',
        region: meta.region || '',
        inn: meta.inn || '',
        verified: meta.verified || false,
        created_at: now,
        updated_at: now
    };

    await createProfile(profileData, accessToken);
    profile = await getProfile(user.id, accessToken);
  }

  const localUsers = readLocal(USERS_FILE);
  const userIdx = localUsers.findIndex(u => u.id === user.id);
  const profileSummary = {
      id: user.id,
      email: user.email || emailFallback || profile?.email,
      name: profile?.name || pickMeta(user).name || '---',
      surname: profile?.surname || pickMeta(user).surname || '',
      organization: profile?.organization || pickMeta(user).organization || '-',
      position: profile?.position || pickMeta(user).position || '',
      phone: profile?.phone || pickMeta(user).phone || '',
      region: profile?.region || pickMeta(user).region || '',
      inn: profile?.inn || pickMeta(user).inn || '',
      verified: profile?.verified || false,
      created_at: profile?.created_at || new Date().toISOString()
  };
  if (userIdx > -1) localUsers[userIdx] = { ...localUsers[userIdx], ...profileSummary };
  else localUsers.push(profileSummary);
  writeLocal(USERS_FILE, localUsers);

  return mergeProfileIntoUser(user, profile);
}

async function supaPasswordSignInRequest(email, password) {
  return requestJson(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: AUTH_HEADERS_ANON,
    body: JSON.stringify({ email, password }),
  });
}

function normalizeSpecs(specs) {
  if (Array.isArray(specs)) return specs;

  if (typeof specs === 'string') {
    try {
      const parsed = JSON.parse(specs);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
    }
    return [specs];
  }

  return [];
}



function isEmailExistsError(message, data) {
  const lowered = String(message || '').toLowerCase();

  return (
    data?.code === 'email_exists' ||
    lowered.includes('already registered') ||
    lowered.includes('already exists') ||
    lowered.includes('email exists') ||
    lowered.includes('user already registered') ||
    lowered.includes('already been registered')
  );
}

async function getProducts() {
  const cached = cacheGet('products');
  if (cached) return cached;

  const data = await supaGet('products', { select: '*' });
  const normalized = data.map((p) => ({
    id: p.id,
    name: p.name,
    cat: p.cat,
    stock: p.stock,
    specs: normalizeSpecs(p.specs),
    img: p.img,
    fullDesc: p.fullDesc,
  }));

  return cacheSet('products', normalized);
}

async function getProductById(id) {
  const key = `products:${id}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const data = await supaGet('products', {
    select: '*',
    id: `eq.${id}`,
    limit: 1,
  });

  const p = Array.isArray(data) ? data[0] : null;

  const normalized = p
    ? {
        id: p.id,
        name: p.name,
        cat: p.cat,
        stock: p.stock,
        specs: normalizeSpecs(p.specs),
        img: p.img,
        fullDesc: p.fullDesc,
      }
    : null;

  return cacheSet(key, normalized);
}

async function getServices() {
  const cached = cacheGet('services');
  if (cached) return cached;

  try {
    const data = await supaGet('services', { select: '*' });
    const normalized = data.map((s) => ({
      id: s.id,
      name: s.name,
      desc: s.desc,
      icon: s.icon,
      cat: s.cat,
      benefits: s.benefits || null,
      img: s.img,
    }));
    return cacheSet('services', normalized);
  } catch (e) {
    return readLocal(SERVICES_FILE);
  }
}

async function getServiceById(id) {
  const key = `services:${id}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    const data = await supaGet('services', {
      select: '*',
      id: `eq.${id}`,
      limit: 1,
    });

    const s = Array.isArray(data) ? data[0] : null;

    const normalized = s
      ? {
          id: s.id,
          name: s.name,
          desc: s.desc,
          icon: s.icon,
          cat: s.cat,
          benefits: s.benefits || null,
          img: s.img,
        }
      : null;

    return cacheSet(key, normalized);
  } catch (e) {
    const local = readLocal(SERVICES_FILE);
    return local.find(s => String(s.id) === String(id)) || null;
  }
}

async function getNews() {
  const cached = cacheGet('news');
  if (cached) return cached;

  const data = await supaGet('news', { select: '*' });
  return cacheSet('news', data);
}

async function getNewsById(id) {
  const key = `news:${id}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const data = await supaGet('news', {
    select: '*',
    id: `eq.${id}`,
    limit: 1,
  });

  const n = Array.isArray(data) ? data[0] : null;
  return cacheSet(key, n);
}

app.post('/api/auth/signin', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');

  if (!email || !password) {
    return res.status(400).json({ message: 'Email и пароль обязательны.' });
  }

  try {
    const signInRes = await supaPasswordSignInRequest(email, password);

    if (!signInRes.ok) {
      let message = extractAuthMessage(
        signInRes.data,
        `Ошибка входа (${signInRes.status})`
      );

      if (/email not confirmed/i.test(String(message))) {
        message = 'Email не подтверждён. Введите код из письма и завершите регистрацию.';
      }

      if (signInRes.status === 429) {
        const retryAfterMs = parseRetryAfterMs(
          headerValue(signInRes.headers, 'retry-after'),
          5000
        );
        return res.status(429).json({ message, retryAfterMs });
      }

      return res.status(signInRes.status).json({ message });
    }

    const payload = signInRes.data || {};
    const accessToken = payload?.access_token || payload?.session?.access_token || '';
    const user = payload?.user || payload?.session?.user || null;

    if (user) {
      await ensureProfileForUser(user, accessToken, email);
      if (payload.session?.user) payload.session.user = user;
      else payload.user = user;
    }

    return res.json(payload);
  } catch (e) {
    console.error('signin error:', e);
    return res
      .status(500)
      .json({ message: 'Сервис авторизации временно недоступен.' });
  }
});

app.post('/api/auth/signup', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');
  const firstName = String(req.body?.firstName || '').trim();
  const lastName = String(req.body?.lastName || '').trim();
  const organization = String(req.body?.organization || '').trim();
  const position = String(req.body?.position || '').trim();
  const phone = String(req.body?.phone || '').trim();
  const region = String(req.body?.region || '').trim();
  const inn = String(req.body?.inn || '').trim();

  if (!email || !password || !firstName || !lastName || !organization || !position || !phone || !region || !inn) {
    return res.status(400).json({ message: 'Заполните все обязательные поля регистрации.' });
  }

  const nameRegex = /^[A-Za-zА-Яа-яЁё\s\-]{2,50}$/;
  if (!nameRegex.test(firstName)) return res.status(400).json({ message: 'Имя может содержать только буквы, пробелы и дефисы (минимум 2 символа).' });
  if (!nameRegex.test(lastName)) return res.status(400).json({ message: 'Фамилия может содержать только буквы, пробелы и дефисы (минимум 2 символа).' });

  const orgRegex = /^[A-Za-zА-Яа-яЁё0-9\s\-_.«»"']{2,150}$/;
  if (!orgRegex.test(organization)) return res.status(400).json({ message: 'Название организации некорректно.' });

  const posRegionRegex = /^[A-Za-zА-Яа-яЁё0-9\s\-\.,]{2,100}$/;
  if (!posRegionRegex.test(position)) return res.status(400).json({ message: 'Должность некорректна (минимум 2 символа).' });
  if (!posRegionRegex.test(region)) return res.status(400).json({ message: 'Регион некорректен (минимум 2 символа).' });

  const phoneClean = phone.replace(/[^\d]/g, '');
  if (phoneClean.length !== 11 || !/^[78]/.test(phoneClean)) {
    return res.status(400).json({ message: 'Телефон должен содержать 11 цифр и начинаться с 7 или 8.' });
  }

  if (!/^(\d{10}|\d{12})$/.test(inn)) {
    return res.status(400).json({ message: 'ИНН должен состоять ровно из 10 или 12 цифр.' });
  }

  const pwdRegex = /^(?=.*[a-zа-яё])(?=.*[A-ZА-ЯЁ])(?=.*\d)[^\s]{8,}$/i;
  if (password.length < 8 || /\s/.test(password) || !/[a-zа-яё]/i.test(password) || !/[A-ZА-ЯЁ]/.test(password) || !/\d/.test(password)) {
    const hasLower = /[a-zа-яё]/i.test(password) && password !== password.toUpperCase();
    const hasUpper = /[a-zа-яё]/i.test(password) && password !== password.toLowerCase();
    const hasDigit = /\d/.test(password);
    const hasNoSpaces = !/\s/.test(password);
    
    if (password.length < 8 || !hasLower || !hasUpper || !hasDigit || !hasNoSpaces) {
        return res.status(400).json({ message: 'Пароль: мин. 8 символов, заглавная и строчная буквы, минимум 1 цифра, без пробелов.' });
    }
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ message: 'Некорректный формат Email.' });
  }

  try {
    const signupRes = await requestJson(`${SUPABASE_URL}/auth/v1/signup`, {
      method: 'POST',
      headers: AUTH_HEADERS_ANON,
      body: JSON.stringify({
        email,
        password,
        data: {
          name: firstName,
          surname: lastName,
          firstName,
          lastName,
          organization,
          position,
          phone,
          region,
          inn,
        },
      }),
    });

    if (!signupRes.ok) {
      const isSmtpError = signupRes.status === 500 && (signupRes.data?.msg?.includes('confirmation email') || signupRes.data?.message?.includes('confirmation email'));
      
      if (!isSmtpError) {
        console.error('Signup failed in Supabase:', signupRes.status, signupRes.data);
        const rawMessage = extractAuthMessage(signupRes.data, `Ошибка регистрации (${signupRes.status})`);

      if (signupRes.status === 429) {
        const retryAfterMs = parseRetryAfterMs(headerValue(signupRes.headers, 'retry-after'), SIGNUP_DEFAULT_COOLDOWN_MS);
        setSignupCooldown(email, retryAfterMs);
        const isEmailLimit = /email rate limit exceeded/i.test(rawMessage);

        return res.status(429).json({
          message: isEmailLimit ? 'Слишком много запросов. Подождите и попробуйте снова.' : rawMessage,
          retryAfterMs,
        });
      }

      if (isEmailExistsError(rawMessage, signupRes.data)) {
        return res.status(409).json({
          message: 'Этот email уже зарегистрирован. Перейдите на вкладку "Вход" или восстановите пароль.',
        });
      }

      return res.status(signupRes.status).json({ message: rawMessage });
    }
  }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    verificationCodes.set(email, {
      code,
      expires: Date.now() + VERIFY_CODE_TTL_MS,
      data: { firstName, lastName, organization, position, phone, region, inn, password }
    });

    try {
      const data = await resend.emails.send({
        from: 'onboarding@resend.dev',
        to: email,
        subject: 'Код подтверждения Зелёный край',
        html: `<h3>Добро пожаловать в компанию Зелёный край!</h3><p>Ваш код подтверждения: <strong>${code}</strong></p><p>Код действителен 15 минут.</p>`
      });
      console.log('Resend response:', data);
      console.log(`Verification code ${code} sent to ${email}`);
    } catch (mailErr) {
      console.error('Failed to send email via Resend:', mailErr);
    }

    return res.json({ 
      message: 'Код подтверждения отправлен на почту.',
      requiresEmailVerification: true,
      email 
    });
  } catch (e) {
    console.error('signup error:', e);
    return res.status(500).json({ message: 'Сервис регистрации временно недоступен.' });
  }
});

app.post('/api/auth/update-user', async (req, res) => {
  const { access_token, data, password } = req.body || {};

  if (!access_token) {
    return res.status(401).json({ message: 'Требуется авторизация.' });
  }

  const body = {};
  if (data && typeof data === 'object') body.data = data;
  if (password) body.password = password;

  if (!Object.keys(body).length) {
    return res.status(400).json({ message: 'Нет данных для обновления.' });
  }

  try {
    const updateRes = await requestJson(`${SUPABASE_URL}/auth/v1/user`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${access_token}`,
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!updateRes.ok) {
      const message = extractAuthMessage(updateRes.data, 'Ошибка обновления профиля');
      return res.status(updateRes.status).json({ message });
    }
    const user = updateRes.data?.user || updateRes.data;
    const userId = user?.id;

    if (userId && data) {
      try {
        await updateProfile(userId, data, access_token);
      } catch (profileErr) {
        console.error('Failed to update profile:', profileErr);
      }
    }

    if (user) {
      await ensureProfileForUser(user, access_token, user.email);
    }

    if (updateRes.data?.user) {
      updateRes.data.user = user;
      return res.json(updateRes.data);
    }

    return res.json(user);
  } catch (e) {
    console.error('update-user error:', e);
    return res.status(500).json({ message: 'Сервис временно недоступен.' });
  }
});

app.post('/api/auth/verify-email', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const token = String(req.body?.token || '').trim();

  if (!email || !token) {
    return res.status(400).json({ message: 'Email и код подтверждения обязательны.' });
  }

  try {
    const stored = verificationCodes.get(email);
    if (!stored || stored.code !== token || Date.now() > stored.expires) {
      return res.status(400).json({ message: 'Неверный или просроченный код подтверждения.' });
    }

    const { firstName, lastName, organization, position, phone, region, inn, password } = stored.data;
    const signupRes = await requestJson(`${SUPABASE_URL}/auth/v1/signup`, {
      method: 'POST',
      headers: AUTH_HEADERS_ANON,
      body: JSON.stringify({
        email,
        password,
        data: { 
          name: firstName,
          surname: lastName,
          firstName, 
          lastName, 
          organization, 
          position, 
          phone, 
          region, 
          inn 
        }
      })
    });

    if (!signupRes.ok) {
      const isAlreadyExists = signupRes.status === 422 && 
        (signupRes.data?.error_code === 'user_already_exists' || 
         signupRes.data?.msg?.includes('already registered') || 
         signupRes.data?.message?.includes('already registered'));

      if (!isAlreadyExists) {
        const msg = extractAuthMessage(signupRes.data, 'Ошибка при создании аккаунта');
        return res.status(signupRes.status).json({ message: msg });
      }
    }

    const signInRes = await supaPasswordSignInRequest(email, password);
    if (!signInRes.ok) {
      return res.status(signInRes.status).json({ message: 'Ошибка входа после подтверждения.' });
    }

    const payload = signInRes.data || {};
    const accessToken = payload?.access_token || payload?.session?.access_token || '';
    const user = payload?.user || payload?.session?.user || null;

    if (user) {
      await ensureProfileForUser(user, accessToken, email);
      await updateProfile(user.id, { verified: true }, accessToken);
      
      verificationCodes.delete(email);
      
      if (payload.session?.user) payload.session.user.user_metadata.verified = true;
      else if (payload.user) payload.user.user_metadata.verified = true;
    }

    return res.json(payload);
  } catch (e) {
    console.error('verify email error:', e);
    return res.status(500).json({ message: 'Сервис подтверждения временно недоступен.' });
  }
});

app.post('/api/auth/resend-code', async (req, res) => {
  const email = normalizeEmail(req.body?.email);

  if (!email) {
    return res.status(400).json({ message: 'Email обязателен.' });
  }

  try {
    const stored = verificationCodes.get(email);
    if (!stored) {
      return res.status(400).json({ message: 'Сессия регистрации не найдена. Начните заново.' });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    stored.code = code;
    stored.expires = Date.now() + VERIFY_CODE_TTL_MS;

    await resend.emails.send({
      from: 'onboarding@resend.dev',
      to: email,
      subject: 'Новый код подтверждения AGROSPHERE',
      html: `<p>Ваш новый код подтверждения: <strong>${code}</strong></p>`
    });

    return res.json({ message: 'Код отправлен повторно.' });
  } catch (e) {
    console.error('resend code error:', e);
    return res.status(500).json({ message: 'Не удалось отправить код.' });
  }
});

app.post('/api/auth/request-password-reset', async (req, res) => {
  const accessToken = String(req.body?.access_token || '').trim();
  if (!accessToken) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const userRes = await supaGetUser(accessToken);
    if (!userRes.ok) return res.status(401).json({ message: 'Invalid token' });
    const user = userRes.data;
    const email = normalizeEmail(user.email);

    const code = Math.floor(100000 + Math.random() * 900000).toString();
   
    verificationCodes.set(email, {
      code,
      expires: Date.now() + VERIFY_CODE_TTL_MS,
      data: { reset: true }
    });

    await resend.emails.send({
      from: 'onboarding@resend.dev',
      to: email,
      subject: 'Код для смены пароля AGROSPHERE',
      html: `<p>Ваш код для подтверждения смены пароля: <strong>${code}</strong></p>`
    });

    return res.json({ message: 'Код подтверждения отправлен на почту.' });
  } catch (e) {
    console.error('password reset request error:', e);
    return res.status(500).json({ message: 'Не удалось отправить код.' });
  }
});

app.post('/api/auth/verify-reset-code', async (req, res) => {
  const { access_token, token } = req.body || {};
  if (!access_token || !token) {
    return res.status(400).json({ message: 'Все поля обязательны.' });
  }

  try {
    const userRes = await supaGetUser(access_token);
    if (!userRes.ok) return res.status(401).json({ message: 'Invalid token' });
    const user = userRes.data;
    const email = normalizeEmail(user.email);

    const stored = verificationCodes.get(email);
    if (!stored || stored.code !== token || Date.now() > stored.expires) {
      return res.status(400).json({ message: 'Неверный или просроченный код.' });
    }

    return res.json({ success: true, message: 'Код подтвержден.' });
  } catch (e) {
    console.error('verify reset code error:', e);
    return res.status(500).json({ message: 'Не удалось проверить код.' });
  }
});

app.post('/api/auth/confirm-password-reset', async (req, res) => {
  const { access_token, token, password } = req.body || {};
  if (!access_token || !token || !password) {
    return res.status(400).json({ message: 'Все поля обязательны.' });
  }

  try {
    const userRes = await supaGetUser(access_token);
    if (!userRes.ok) return res.status(401).json({ message: 'Invalid token' });
    const user = userRes.data;
    const email = normalizeEmail(user.email);

    const stored = verificationCodes.get(email);
    if (!stored || stored.code !== token || Date.now() > stored.expires) {
      return res.status(400).json({ message: 'Неверный или просроченный код.' });
    }

    const updateRes = await requestJson(`${SUPABASE_URL}/auth/v1/user`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${access_token}`,
        Accept: 'application/json',
      },
      body: JSON.stringify({ password }),
    });

    if (!updateRes.ok) {
        const message = extractAuthMessage(updateRes.data, 'Ошибка обновления пароля');
        return res.status(updateRes.status).json({ message });
    }

    verificationCodes.delete(email);
    return res.json({ success: true, message: 'Пароль успешно изменен.' });
  } catch (e) {
    console.error('password reset confirm error:', e);
    return res.status(500).json({ message: 'Не удалось изменить пароль.' });
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ message: 'Email обязателен.' });

  const normEmail = normalizeEmail(email);
  
  try {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    verificationCodes.set(normEmail, {
      code,
      expires: Date.now() + VERIFY_CODE_TTL_MS,
      data: { forgot: true }
    });

    await resend.emails.send({
      from: 'onboarding@resend.dev',
      to: normEmail,
      subject: 'Восстановление пароля AGROSPHERE',
      html: `<p>Ваш код для восстановления пароля: <strong>${code}</strong></p>`
    });

    return res.json({ message: 'Код восстановления отправлен на почту.' });
  } catch (e) {
    console.error('forgot password error:', e);
    return res.status(500).json({ message: 'Не удалось отправить код.' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { email, token, password } = req.body || {};
  if (!email || !token || !password) {
    return res.status(400).json({ message: 'Все поля обязательны.' });
  }

  const normEmail = normalizeEmail(email);
  
  try {
    const stored = verificationCodes.get(normEmail);
    if (!stored || stored.code !== token || Date.now() > stored.expires) {
      return res.status(400).json({ message: 'Неверный или просроченный код.' });
    }

    
    const updateRes = await requestJson(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        }
    });

    const usersRes = await requestJson(`${SUPABASE_URL}/auth/v1/admin/users?email=eq.${normEmail}`, {
        headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
    });
    
    const user = usersRes.data?.[0];
    if (!user) return res.status(404).json({ message: 'Пользователь не найден.' });

    const finalRes = await requestJson(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ password }),
    });

    if (!finalRes.ok) throw new Error('Ошибка обновления пароля');

    verificationCodes.delete(normEmail);
    return res.json({ success: true, message: 'Пароль успешно сброшен.' });
  } catch (e) {
    console.error('reset password error:', e);
    return res.status(500).json({ message: 'Не удалось восстановить пароль.' });
  }
});

app.post('/api/auth/me', async (req, res) => {
  const accessToken = String(req.body?.access_token || '').trim();

  if (!accessToken) {
    return res.status(401).json({ message: 'Требуется авторизация.' });
  }

  try {
    const userRes = await requestJson(`${SUPABASE_URL}/auth/v1/user`, {
      method: 'GET',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!userRes.ok) {
      const message = extractAuthMessage(userRes.data, 'Не удалось получить профиль пользователя.');
      return res.status(userRes.status).json({ message });
    }

    const user = userRes.data;
    await ensureProfileForUser(user, accessToken, user?.email);

    return res.json(user);
  } catch (e) {
    console.error('auth me error:', e);
    return res.status(500).json({ message: 'Сервис профиля временно недоступен.' });
  }
});

const products = [
  {
    id: 1,
    name: 'Пшеница 3 класса',
    cat: 'Зерновые',
    stock: '150 тонн',
    specs: ['Влажность: 12%', 'Клейковина: 25%', 'Белок: 13%'],
    img: '/media/pshenica.jpg',
  },
  {
    id: 2,
    name: 'Ячмень пивоваренный',
    cat: 'Зерновые',
    stock: '80 тонн',
    specs: ['Влажность: 11%', 'Экстрактивность: 80%', 'Белок: 10%'],
    img: '/media/yach.jpg',
  },
  {
    id: 3,
    name: 'Кукуруза фуражная',
    cat: 'Зерновые',
    stock: '200 тонн',
    specs: ['Влажность: 14%', 'Сорная примесь: 2%', 'Зерновая примесь: 5%'],
    img: '/media/kykyryza.webp',
  },
  {
    id: 4,
    name: 'Соя продовольственная',
    cat: 'Бобовые',
    stock: '45 тонн',
    specs: ['Белок: 38%', 'Масличность: 20%', 'Влажность: 10%'],
    img: '/media/soya.webp',
  },
  {
    id: 5,
    name: 'Горох желтый',
    cat: 'Бобовые',
    stock: '60 тонн',
    specs: ['Чистота: 99%', 'Влажность: 14%', 'Размер: 6+ мм'],
    img: '/media/gorox.webp',
  },
  {
    id: 6,
    name: 'Подсолнечник',
    cat: 'Масличные',
    stock: '120 тонн',
    specs: ['Масличность: 48%', 'Влажность: 7%', 'Кислотное число: 1.5'],
    img: '/media/pods.jpg',
  },
  {
    id: 7,
    name: 'Рапс озимый',
    cat: 'Масличные',
    stock: '30 тонн',
    specs: ['Масличность: 42%', 'Эруковая кислота: 0.5%', 'Влажность: 8%'],
    img: '/media/raps.jpg',
  },
  {
    id: 8,
    name: 'Комбикорм ПК-1',
    cat: 'Корма',
    stock: '15 тонн',
    specs: ['Протеин: 17%', 'Клетчатка: 5%', 'Срок годности: 6 мес'],
    img: '/media/kombikorm.png',
  },
];

const services = [
  {
    id: 'lab',
    name: 'Лабораторный анализ',
    desc: 'Полный спектр исследований качества зерновых и масличных культур.',
    icon: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  },
  {
    id: 'log',
    name: 'Логистика и экспорт',
    desc: 'Организация поставок авто, ж/д и водным транспортом (FOB, CPT).',
    icon: 'M20 7h-9l-3-3H2v16h20V7z',
  },
  {
    id: 'drones',
    name: 'Агросканирование',
    desc: 'Мониторинг посевов с помощью беспилотных комплексов и ИИ.',
    icon: 'M12 2v20m10-10H2',
  },
];

const news = [
  {
    id: 1,
    title: 'Итоги уборочной кампании 2026: Рекордные показатели',
    date: '15.11.2026',
    cat: 'Корпоративные',
    excerpt:
      'В этом году "Зеленый край" достиг увеличения урожайности на 12.5% благодаря внедрению систем точного земледелия.',
    img: 'https://images.unsplash.com/photo-1523348837708-15d4a09cfac2?auto=format&fit=crop&w=1200',
  },
  {
    id: 2,
    title: 'Новый парк автономных комбайнов поступил в эксплуатацию',
    date: '02.10.2026',
    cat: 'Технологии',
    excerpt:
      'Десять единиц беспилотной техники начали работу на полях Алтайского кластера.',
    img: 'https://avatars.mds.yandex.net/i?id=98a8d4b3d012f8b5f055662c3dfbd4e2_l-4355007-images-thumbs&n=13',
  },
  {
    id: 3,
    title: 'Аналитика рынка: Прогнозы цен на пшеницу 2026',
    date: '20.09.2026',
    cat: 'Аналитика',
    excerpt:
      'Наши эксперты подготовили подробный отчет о волатильности цен на зерновые культуры в следующем сезоне.',
    img: 'https://images.unsplash.com/photo-1574323347407-f5e1ad6d020b?auto=format&fit=crop&w=800',
  },
  {
    id: 4,
    title: 'AgroSphere получила сертификат экологической безопасности',
    date: '05.08.2026',
    cat: 'Устойчивое развитие',
    excerpt:
      'Мы подтвердили статус производителя экологически чистого сырья, соответствующего международным стандартам.',
    img: 'https://images.unsplash.com/photo-1464226184884-fa280b87c399?auto=format&fit=crop&w=800',
  },
];

const galleryItems = [
    { id: 1, cat: "Техника", title: "Беспилотный комбайн S-500", loc: "Алтайский кластер", img: "https://mirbelogorya.ru/images/stories/news/2020/09/kombayn_bespilotnik.jpg" },
    { id: 2, cat: "Поля", title: "Пшеница озимая, 4-я стадия", loc: "Краснодарский край", img: "https://images.unsplash.com/photo-1500382017468-9049fed747ef?auto=format&fit=crop&w=1200" },
    { id: 3, cat: "Лаборатория", title: "Анализ молекулярного состава", loc: "Сколково R&D", img: "https://images.unsplash.com/photo-1581092580497-e0d23cbdf1dc?auto=format&fit=crop&w=1200" },
    { id: 4, cat: "Техника", title: "Дрон-опрыскиватель Horus", loc: "Воронежская обл.", img: "https://avatars.mds.yandex.net/i?id=1f2345225fba474108dac5dffdd28cab_l-4245249-images-thumbs&n=13" },
    { id: 5, cat: "Поля", title: "Система умного полива", loc: "Ростовский кластер", img: "https://i.ytimg.com/vi/ceCLM-FLmQ8/maxresdefault.jpg" },
    { id: 6, cat: "Лаборатория", title: "Контроль качества зерна", loc: "Центральный элеватор", img: "https://avatars.mds.yandex.net/get-altay/4284571/2a0000017887009c98a2d3c2e75f21777e46/XXL_height" }
];

app.get('/api/gallery', (req, res) => res.json(galleryItems));
app.get('/api/products', async (req, res) => {
  try {
    const data = await getProducts();
    const enhancedData = data.map(dbProd => {
      const localProd = products.find(lp => lp.id === dbProd.id);
      if (localProd && localProd.img) {
        return { ...dbProd, img: localProd.img };
      }
      return dbProd;
    });
    res.json(enhancedData);
  } catch (e) {
    console.error(e.message);
    res.json(products);
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const data = await getProductById(req.params.id);
    if (!data) return res.status(404).send('Not found');
    const localProd = products.find(lp => lp.id == req.params.id);
    if (localProd && localProd.img) {
      data.img = localProd.img;
    }
    
    res.json(data);
  } catch (e) {
    console.error(e.message);
    const p = products.find((i) => i.id == req.params.id);
    return p ? res.json(p) : res.status(404).send('Not found');
  }
});

app.get('/api/services', async (req, res) => {
  try {
    const data = await getServices();
    res.json(data);
  } catch (e) {
    console.error(e.message);
    res.json(services);
  }
});

app.get('/api/services/:id', async (req, res) => {
  try {
    const data = await getServiceById(req.params.id);
    if (!data) return res.status(404).send('Not found');
    res.json(data);
  } catch (e) {
    console.error(e.message);
    const s = services.find((i) => String(i.id) === String(req.params.id));
    return s ? res.json(s) : res.status(404).send('Not found');
  }
});

app.get('/api/news', async (req, res) => {
  try {
    const data = await getNews();
    const enhancedData = data.map(dbNews => {
      const local = news.find(n => n.id === dbNews.id);
      return local ? { ...dbNews, ...local } : dbNews;
    });
    res.json(enhancedData);
  } catch (e) {
    console.error(e.message);
    res.json(news);
  }
});

app.get('/api/news/:id', async (req, res) => {
  try {
    const data = await getNewsById(req.params.id);
    if (!data) {

      const n = news.find(i => String(i.id) === String(req.params.id));
      return n ? res.json(n) : res.status(404).send('Not found');
    }

    const local = news.find(n => String(n.id) === String(req.params.id));
    if (local) {
      Object.assign(data, local);
    }
    
    res.json(data);
  } catch (e) {
    console.error(e.message);
    const n = news.find(i => String(i.id) === String(req.params.id));
    return n ? res.json(n) : res.status(404).send('Not found');
  }
});

app.post('/api/service-requests', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1] || req.body?.access_token;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });

  const { serviceId, serviceName, volume, timeline, options } = req.body;
  
  try {
    const userRes = await supaGetUser(token);
    if (!userRes.ok) return res.status(401).json({ message: 'Invalid token' });
    const user = userRes.data;

    const requestData = {
      user_id: user.id,
      user_email: user.email,
      service_id: serviceId,
      service_name: serviceName,
      volume: volume,
      timeline: timeline,
      options: options,
      status: 'pending',
      created_at: new Date().toISOString()
    };

    let savedToTable = false;
    try {
        await supaPost('service_requests', requestData);
        savedToTable = true;
    } catch (err) {
        console.warn('service_requests table missing/error, falling back to metadata:', err.message);
    }
    
    if (!savedToTable) {

        const meta = pickMeta(user);
        const history = meta.service_history || [];
        history.push(requestData);
        await supaUpdateUserMetadata(token, { service_history: history });
    }


    const localServices = readLocal(SERVICES_FILE);
    localServices.push({ ...requestData, id: 'sr-' + Math.random().toString(36).substr(2, 5) });
    writeLocal(SERVICES_FILE, localServices);

    res.json({ success: true, message: 'Request saved' });
  } catch (e) {
    console.error('service-request error:', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});


app.post('/api/orders', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1] || req.body?.access_token;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });

  const { productId, productName, volume, services, comment, attachmentUrl } = req.body;
  
  try {
    const userRes = await supaGetUser(token);
    if (!userRes.ok) return res.status(401).json({ message: 'Invalid token' });
    const user = userRes.data;

    const orderData = {
      user_id: user.id,
      user_email: user.email,
      product_id: productId,
      product_name: productName,
      volume: volume,
      services: services || [],
      comment: comment || '',
      attachment_url: attachmentUrl || '',
      status: 'new',
      created_at: new Date().toISOString(),
      tracking_data: {
        from: [45.0355, 38.9753], 
        to: [44.6939, 37.7735],  
        current: [45.0355, 38.9753],
        description: 'Ожидание отгрузки'
      }
    };

    let savedToTable = false;
    try {
        await supaPost('orders', orderData);
        savedToTable = true;
    } catch (err) {
        console.warn('orders table missing/error, falling back to metadata:', err.message);
    }
    
    if (!savedToTable) {
        const meta = pickMeta(user);
        const history = meta.order_history || [];
        history.push(orderData);
        await supaUpdateUserMetadata(token, { order_history: history });
    }

    const localOrders = readLocal(ORDERS_FILE);
    const localId = 'ord-' + Math.random().toString(36).substr(2, 7);
    localOrders.push({ ...orderData, id: localId });
    writeLocal(ORDERS_FILE, localOrders);

    res.json({ success: true, message: 'Order placed successfully', order_id: localId });
  } catch (e) {
    console.error('order error:', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.get('/api/orders', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader ? authHeader.split(' ')[1] : req.query.token;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const userRes = await supaGetUser(token);
    if (!userRes.ok) return res.status(401).json({ message: 'Invalid token' });
    const user = userRes.data;

    let orders = [];
    try {
        const tableOrders = await supaGet('orders', { user_id: `eq.${user.id}`, order: 'created_at.desc' });
        if (Array.isArray(tableOrders)) orders = tableOrders;
    } catch (err) {
        console.warn('orders table access error:', err.message);
    }
    
    const meta = pickMeta(user);
    const metaOrders = meta.order_history || [];
    
    const tableOrderIds = new Set(orders.map(o => o.id));
    const uniqueMetaOrders = metaOrders.filter(o => !tableOrderIds.has(o.id));
    
    orders = [...orders, ...uniqueMetaOrders];
    orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    return res.json(orders);
  } catch (e) {
    console.error('get orders error:', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.get('/api/admin/orders', async (req, res) => {
    const authHeader = req.headers.authorization;
    const token = authHeader ? authHeader.split(' ')[1] : req.query.token;
    if (!token) return res.status(401).json({ message: 'Unauthorized' });

    try {
        const hasRootCookie = req.cookies.access_level === 'root';
        const userRes = await supaGetUser(token);
        if (!userRes.ok && !hasRootCookie) return res.status(401).json({ message: 'Invalid token' });
        
        const user = userRes.data || {};
        const meta = pickMeta(user);
        const isAdmin = hasRootCookie || user.email?.includes('admin') || meta.organization === 'AGROSPHERE' || meta.role === 'admin';
        
        if (!isAdmin) return res.status(403).json({ message: 'Forbidden: Admin access required' });

        let allOrders = [];
        try {
            const tableOrders = await supaGet('orders', { order: 'created_at.desc' });
            if (Array.isArray(tableOrders)) allOrders = [...tableOrders];
        } catch (err) {
            console.warn('Admin: Supabase "orders" table access error:', err.message);
        }

        const localOrders = readLocal(ORDERS_FILE);
        localOrders.forEach(lo => {
            if (!allOrders.find(o => o.user_id === lo.user_id && o.created_at === lo.created_at)) {
                allOrders.push(lo);
            }
        });

        try {
            const profiles = await supaGet('profiles');
            if (Array.isArray(profiles)) {
                profiles.forEach(p => {
                   const history = p.order_history || p.user_metadata?.order_history || [];
                   if (Array.isArray(history)) {
                       history.forEach(o => {
                           if (!allOrders.find(existing => existing.id === o.id || (existing.user_id === o.user_id && existing.created_at === o.created_at))) {
                               allOrders.push({ ...o, from_meta: true, user_email: o.user_email || p.email });
                           }
                       });
                   }
                });
            }
        } catch (pErr) {
            console.warn('Admin: Profile scan failed:', pErr.message);
        }

        allOrders.sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
        res.json(allOrders);
    } catch (e) {
        console.error('admin get orders error:', e);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.get('/api/admin/users', async (req, res) => {
    const hasRootCookie = req.cookies.access_level === 'root';
    if (!hasRootCookie) return res.status(403).json({ message: 'Forbidden' });

    if (!SUPABASE_SERVICE_ROLE_KEY) {
        console.error('Admin GET users error: SUPABASE_SERVICE_ROLE_KEY is missing in .env');
        // Return local users anyway but warn
        return res.json(readLocal(USERS_FILE).map(p => ({
            id: p.user_id || p.id,
            email: p.email,
            name: p.name || '',
            surname: p.surname || '',
            full_name: `${p.name || ''} ${p.surname || ''}`.trim() || p.email || 'No Name',
            organization: p.organization || '-',
            position: p.position || '',
            phone: p.phone || '',
            region: p.region || '',
            inn: p.inn || '',
            verified: p.verified || false,
            created_at: p.created_at || 'unknown'
        })));
    }

    try {
        let profiles = [];
        profiles = readLocal(USERS_FILE);

        try {
            // Use Service Role to get ALL profiles regardless of RLS
            const data = await supaGet('profiles', {}, AUTH_HEADERS_SERVICE);
            if (Array.isArray(data)) {
                data.forEach(dp => {
                    const existingIdx = profiles.findIndex(p => p.id === dp.user_id || p.id === dp.id);
                    if (existingIdx > -1) {
                        // Merge Supabase data into local data
                        profiles[existingIdx] = { ...profiles[existingIdx], ...dp };
                    } else {
                        profiles.push(dp);
                    }
                });
            }
        } catch (e) {
            console.warn('Admin: profiles table error:', e.message);
        }
        
        const userList = profiles.map(p => ({
            id: p.user_id || p.id,
            email: p.email,
            name: p.name || '',
            surname: p.surname || '',
            full_name: `${p.name || ''} ${p.surname || ''}`.trim() || p.email || 'No Name',
            organization: p.organization || '-',
            position: p.position || '',
            phone: p.phone || '',
            region: p.region || '',
            inn: p.inn || '',
            verified: p.verified || false,
            created_at: p.created_at || 'unknown'
        }));

        res.json(userList);
    } catch (e) {
        console.error('admin get users error:', e);
        res.json([]);
    }
});

app.patch('/api/admin/users/:id', async (req, res) => {
    const hasRootCookie = req.cookies.access_level === 'root';
    if (!hasRootCookie) return res.status(403).json({ message: 'Forbidden' });

    if (!SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(500).json({ 
            message: 'Ошибка синхронизации: отсутствует SUPABASE_SERVICE_ROLE_KEY в .env конфигурации.' 
        });
    }

    const userId = req.params.id;
    const body = req.body;

    // Strict whitelisting of fields that can be updated in profiles table
    const updateData = {};
    const allowedFields = ['name', 'surname', 'organization', 'position', 'phone', 'region', 'inn', 'verified'];
    allowedFields.forEach(f => {
        if (body[f] !== undefined) updateData[f] = body[f];
    });

    try {
        // 1. Get user email from local storage or Supabase Auth
        const localUsers = readLocal(USERS_FILE);
        const userIdx = localUsers.findIndex(u => u.id === userId);
        const userEmail = localUsers[userIdx]?.email;

        // 2. Update in Supabase Profiles Table (Upsert Logic)
        const profile = await getProfile(userId);
        if (profile) {
            await updateProfile(userId, {
                ...updateData,
                updated_at: new Date().toISOString()
            });
        } else {
            // Create profile if missing - MUST include email
            await createProfile({
                user_id: userId,
                email: userEmail || '', 
                ...updateData,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });
        }

        // 3. Sync with Supabase Auth Metadata (Service Role)
        await supaAdminUpdateUser(userId, updateData);

        // 4. Update in Local USERS_FILE
        if (userIdx > -1) {
            localUsers[userIdx] = {
                ...localUsers[userIdx],
                ...updateData,
                // Ensure specific field mappings match updateData keys
                name: updateData.name !== undefined ? updateData.name : localUsers[userIdx].name,
                surname: updateData.surname !== undefined ? updateData.surname : localUsers[userIdx].surname,
                organization: updateData.organization !== undefined ? updateData.organization : localUsers[userIdx].organization,
                position: updateData.position !== undefined ? updateData.position : localUsers[userIdx].position,
                phone: updateData.phone !== undefined ? updateData.phone : localUsers[userIdx].phone,
                region: updateData.region !== undefined ? updateData.region : localUsers[userIdx].region,
                inn: updateData.inn !== undefined ? updateData.inn : localUsers[userIdx].inn,
                verified: updateData.verified !== undefined ? updateData.verified : localUsers[userIdx].verified
            };
            writeLocal(USERS_FILE, localUsers);
        }

        res.json({ success: true, message: 'Данные пользователя обновлены' });
    } catch (e) {
        console.error('admin update user error:', e);
        res.status(500).json({ message: 'Ошибка при обновлении пользователя' });
    }
});

app.get('/api/admin/stats', async (req, res) => {
    const hasRootCookie = req.cookies.access_level === 'root';
    if (!hasRootCookie) return res.status(403).json({ message: 'Forbidden' });

    let dbStatus = 'offline';
    try {
        let allOrders = [];
        let profiles = [];

        allOrders = readLocal(ORDERS_FILE);
        profiles = readLocal(USERS_FILE);

        try {
            const tableOrders = await supaGet('orders');
            if (Array.isArray(tableOrders)) {
                tableOrders.forEach(to => {
                    if (!allOrders.find(o => o.user_id === to.user_id && o.created_at === to.created_at)) {
                        allOrders.push(to);
                    }
                });
                dbStatus = 'online';
            }
        } catch (e) { dbStatus = 'error'; }

        try {
            const pData = await supaGet('profiles');
            if (Array.isArray(pData)) {
                pData.forEach(p => {
                    if (!profiles.find(lp => lp.id === p.user_id || lp.id === p.id)) {
                        profiles.push(p);
                    }
                    const history = p.order_history || p.user_metadata?.order_history || [];
                    if (Array.isArray(history)) {
                        history.forEach(o => {
                            if (!allOrders.find(existing => existing.id === o.id || (existing.user_id === o.user_id && existing.created_at === o.created_at))) {
                                allOrders.push(o);
                            }
                        });
                    }
                });
            }
        } catch (e) {}

        const totalOrders = allOrders.length;
        const totalVolume = allOrders.reduce((acc, o) => acc + (parseFloat(o.volume) || 0), 0);
        const activeOrders = allOrders.filter(o => !['done', 'cancelled'].includes(o.status));
        const activeVolume = activeOrders.reduce((acc, o) => acc + (parseFloat(o.volume) || 0), 0);
        
        const now = new Date();
        const thisMonth = allOrders.filter(o => {
            const d = new Date(o.created_at);
            return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        }).length;

        res.json({
            dbStatus,
            totalOrders: totalOrders,
            newThisMonth: thisMonth,
            totalVolume: totalVolume.toFixed(1),
            activeVolume: activeVolume.toFixed(1),
            totalUsers: profiles.length,
            verifiedUsers: profiles.filter(p => p.verified).length
        });
    } catch (e) {
        console.error('admin stats error:', e);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.post('/api/admin/products', async (req, res) => {
    const hasRootCookie = req.cookies.access_level === 'root';
    if (!hasRootCookie) return res.status(403).json({ message: 'Forbidden' });

    try {
        const product = req.body;
        if (product.specs && typeof product.specs === 'string') {
            try { product.specs = JSON.parse(product.specs); } catch(e) {}
        }
        
        const data = await supaPost('products', product);
        cacheSet('products', null); 
        res.json({ success: true, data });
    } catch (e) {
        console.error('admin add product error:', e);
        res.status(500).json({ message: 'Error adding product: ' + e.message });
    }
});

app.delete('/api/admin/products/:id', async (req, res) => {
    const hasRootCookie = req.cookies.access_level === 'root';
    if (!hasRootCookie) return res.status(403).json({ message: 'Forbidden' });

    try {
        await supaDelete('products', req.params.id);
        cacheSet('products', null);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ message: 'Error deleting product' });
    }
});

app.post('/api/admin/services', async (req, res) => {
    const hasRootCookie = req.cookies.access_level === 'root';
    if (!hasRootCookie) return res.status(403).json({ message: 'Forbidden' });

    try {
        const service = req.body;
        const data = await supaPost('services', service);
        cacheSet('services', null);
        res.json({ success: true, data });
    } catch (e) {
        console.error('admin add service error:', e);
        res.status(500).json({ message: 'Error adding service' });
    }
});

app.delete('/api/admin/services/:id', async (req, res) => {
    const hasRootCookie = req.cookies.access_level === 'root';
    if (!hasRootCookie) return res.status(403).json({ message: 'Forbidden' });

    try {
        const resData = await requestJson(`${SUPABASE_URL}/rest/v1/services?id=eq.${encodeURIComponent(req.params.id)}`, {
            method: 'DELETE',
            headers: REST_HEADERS
        });
        if (!resData.ok) throw new Error('Delete failed');
        
        cacheSet('services', null);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ message: 'Error deleting service' });
    }
});

app.patch('/api/orders/:id', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1] || req.body?.access_token;
    if (!token) return res.status(401).json({ message: 'Unauthorized' });

    const { status, tracking_data } = req.body;
    const orderId = req.params.id;

    try {
        const hasRootCookie = req.cookies.access_level === 'root';
        const userRes = await supaGetUser(token);
        if (!userRes.ok && !hasRootCookie) return res.status(401).json({ message: 'Invalid token' });

    
        const isAdmin = hasRootCookie || (userRes.ok && (userRes.data.email?.includes('admin') || pickMeta(userRes.data).role === 'admin'));
        
        if (!isAdmin) return res.status(403).json({ message: 'Forbidden' });

        const updateData = {};
        if (status) updateData.status = status;
        if (tracking_data) updateData.tracking_data = tracking_data;

        try {
            await supaPatch('orders', orderId, updateData);
        } catch (dbErr) {
            console.warn('Sync: supaPatch failed, only local/meta will be used:', dbErr.message);
        }

        const localOrders = readLocal(ORDERS_FILE);
        const lIdx = localOrders.findIndex(o => o.id === orderId);
        if (lIdx > -1) {
            localOrders[lIdx] = { ...localOrders[lIdx], ...updateData };
            writeLocal(ORDERS_FILE, localOrders);
        }

        res.json({ success: true, message: 'Order updated' });
    } catch (e) {
        console.error('patch order error:', e);
        res.status(500).json({ message: 'Failed to update order' });
    }
});

app.get('/api/service-requests', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader ? authHeader.split(' ')[1] : req.query.token;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const userRes = await supaGetUser(token);
    if (!userRes.ok) return res.status(401).json({ message: 'Invalid token' });
    const user = userRes.data;

    let requests = [];
    try {
        const tableRes = await supaGet('service_requests', { user_id: `eq.${user.id}`, order: 'created_at.desc' });
        if (Array.isArray(tableRes)) requests = tableRes;
    } catch (err) {
        console.warn('service_requests table access error:', err.message);
    }
    
    const meta = pickMeta(user);
    const metaReqs = meta.service_history || [];
    const tableReqIds = new Set(requests.map(r => r.id));
    const uniqueMetaReqs = metaReqs.filter(r => !tableReqIds.has(r.id));
    
    requests = [...requests, ...uniqueMetaReqs];
    requests.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    return res.json(requests);
  } catch (e) {
    console.error('get service-requests error:', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.get('/api/notifications', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader ? authHeader.split(' ')[1] : req.query.token;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const userRes = await supaGetUser(token);
    if (!userRes.ok) return res.status(401).json({ message: 'Invalid token' });
    const user = userRes.data;

    let tableNotifs = [];
    try {
        const tableRes = await supaGet('notifications', { user_id: `eq.${user.id}`, order: 'created_at.desc' });
        if (Array.isArray(tableRes)) tableNotifs = tableRes;
    } catch (err) {
        console.warn('notifications table access error:', err.message);
    }
  
    const meta = pickMeta(user);
    const metaNotifs = meta.notifications || [];

    const tableTexts = new Set(tableNotifs.map(n => n.text + n.created_at));
    const uniqueMetaNotifs = metaNotifs.filter(n => !tableTexts.has(n.text + (n.created_at || n.time)));
    
    let allNotifs = [...tableNotifs, ...uniqueMetaNotifs];
    allNotifs.sort((a, b) => new Date(b.created_at || b.time) - new Date(a.created_at || a.time));
    
    return res.json(allNotifs);
  } catch (e) {
    console.error('get notifications error:', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.post('/api/notifications', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1] || req.body?.access_token;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });

  const { text } = req.body;
  
  try {
    const userRes = await supaGetUser(token);
    if (!userRes.ok) return res.status(401).json({ message: 'Invalid token' });
    const user = userRes.data;

    const notifData = {
      user_id: user.id,
      text: text,
      read: false,
      time: new Date().toISOString(),
      created_at: new Date().toISOString()
    };

    let savedToTable = false;
    try {
        await supaPost('notifications', notifData);
        savedToTable = true;
    } catch (err) {
        console.warn('notifications table missing/error, falling back to metadata:', err.message);
    }
    
    if (!savedToTable) {
        const meta = pickMeta(user);
        const notifs = meta.notifications || [];
        notifs.unshift(notifData);
        if (notifs.length > 50) notifs.length = 50;
        await supaUpdateUserMetadata(token, { notifications: notifs });
    }

    res.json({ success: true });
  } catch (e) {
    console.error('post notification error:', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.post('/api/notifications/read-all', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1] || req.body?.access_token;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const userRes = await supaGetUser(token);
    if (!userRes.ok) return res.status(401).json({ message: 'Invalid token' });
    const user = userRes.data;

    const meta = pickMeta(user);
    if (meta.notifications) {
        meta.notifications.forEach(n => n.read = true);
        await supaUpdateUserMetadata(token, { notifications: meta.notifications });
    }

    try {
        await supaClient.from('notifications').update({ read: true }).eq('user_id', user.id).eq('read', false);
    } catch (err) {
    }

    res.json({ success: true });
  } catch (e) {
    console.error('read-all error:', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});


app.post('/api/sys/activate', express.json(), (req, res) => {
    const { token } = req.body;
    if (token === '7741' || token === '7741-agro-core-access') { 
        res.cookie('access_level', 'root', { 
            httpOnly: true, 
            maxAge: 3600000, 
            sameSite: 'strict',
            path: '/' 
        });
        res.json({ status: 'ready', message: 'ACCESS LEVEL: ROOT' });
    } else {
        res.status(403).json({ status: 'denied', message: 'INCORRECT SYSTEM KEY' });
    }
});

app.get('/api/history', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader ? authHeader.split(' ')[1] : req.query.token;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const userRes = await supaGetUser(token);
    if (!userRes.ok) return res.status(401).json({ message: 'Invalid token' });
    const user = userRes.data;

    const meta = pickMeta(user);
    const history = meta.history || [];
    history.sort((a, b) => new Date(b.time) - new Date(a.time));
    
    return res.json(history);
  } catch (e) {
    console.error('get history error:', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.post('/api/history', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1] || req.body?.access_token;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });

  const { action } = req.body;
  
  try {
    const userRes = await supaGetUser(token);
    if (!userRes.ok) return res.status(401).json({ message: 'Invalid token' });
    const user = userRes.data;

    const historyData = {
      action: action,
      time: new Date().toISOString()
    };

    const meta = pickMeta(user);
    const history = meta.history || [];
    history.unshift(historyData);
    if (history.length > 50) history.length = 50;
    
    await supaUpdateUserMetadata(token, { history: history });

    res.json({ success: true });
  } catch (e) {
    console.error('post history error:', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.get('/api/support/messages', (req, res) => {
  const sessionId = String(req.query.sessionId || '').trim();
  if (!sessionId) return res.status(400).json({ message: 'sessionId required' });

  const since = String(req.query.since || '').trim();
  const chats = readSupportChats();
  const chat = chats.find((c) => c.sessionId === sessionId);
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  const filtered = since ? messages.filter((m) => String(m.time) > since) : messages;
  return res.json({ messages: filtered });
});

app.post('/api/support/messages', async (req, res) => {
  const sessionId = String(req.body?.sessionId || '').trim();
  const text = String(req.body?.text || '').trim();
  const userLabel = String(req.body?.userLabel || 'Пользователь').trim();
  if (!sessionId || !text) return res.status(400).json({ message: 'sessionId and text required' });

  const chats = readSupportChats();
  const chat = getOrCreateSupportChat(chats, sessionId, userLabel);
  const msg = createMessage('user', text, 'site');
  chat.messages.push(msg);
  chat.updatedAt = new Date().toISOString();
  writeSupportChats(chats);

  const bridge = readSupportBridge();
  const targetPeerId = VK_SUPPORT_PEER_ID || Number(bridge.operatorPeerId || 0);
  let vkForwardStatus = { attempted: false, sent: false };

  if (targetPeerId && VK_GROUP_TOKEN) {
    vkForwardStatus.attempted = true;
    try {
      console.log('[Support] Forwarding to VK:', targetPeerId, 'text:', text.slice(0, 50));
      await vkApi('messages.send', {
        peer_id: targetPeerId,
        random_id: Math.floor(Math.random() * 1000000),
        message: `[Чат ${sessionId}]\n${userLabel}: ${text}\n\nМожно ответить так:\n/reply ${sessionId} ваш текст\nили просто ответом на это сообщение.`,
      });
      console.log('[Support] Forwarding to VK: SUCCESS');
      vkForwardStatus.sent = true;
      bridge.lastSessionByPeer = bridge.lastSessionByPeer || {};
      bridge.lastSessionByPeer[String(targetPeerId)] = sessionId;
      bridge.lastSessionId = sessionId;
      bridge.lastForwardOkAt = new Date().toISOString();
      bridge.lastForwardError = '';
      writeSupportBridge(bridge);
    } catch (e) {
      console.error('VK forward error:', e.message);
      bridge.lastForwardError = String(e.message || 'unknown VK forward error');
      bridge.lastForwardErrorAt = new Date().toISOString();
      writeSupportBridge(bridge);
    }
  } else if (targetPeerId && !VK_GROUP_TOKEN) {
    vkForwardStatus = { attempted: false, sent: false, skipped: true, reason: 'VK_GROUP_TOKEN not set' };
    if (!warnedVkNoToken) {
      warnedVkNoToken = true;
      console.warn(
        '[VK] Пересылка в личку отключена: нет VK_GROUP_TOKEN. Добавьте токен сообщества в .env (см. .env.example) и перезапустите сервер.'
      );
    }
  } else if (!targetPeerId && VK_GROUP_TOKEN) {
    vkForwardStatus = { attempted: false, sent: false, skipped: true, reason: 'no peer_id' };
    if (!warnedVkNoPeer) {
      warnedVkNoPeer = true;
      console.warn(
        '[VK] Укажите VK_SUPPORT_PEER_ID (числовой peer_id админа в переписке с сообществом) или настройте Callback API и отправьте /bind из диалога.'
      );
    }
  }

  return res.json({ success: true, message: msg, vk: vkForwardStatus, operatorPeerId: targetPeerId || null });
});

app.get('/api/support/debug', (req, res) => {
  const bridge = readSupportBridge();
  const chats = readSupportChats();
  const lastChat = chats[chats.length - 1] || null;
  return res.json({
    hasVkToken: Boolean(VK_GROUP_TOKEN),
    configuredPeerId: VK_SUPPORT_PEER_ID || null,
    boundPeerId: Number(bridge.operatorPeerId || 0) || null,
    lastForwardError: bridge.lastForwardError || '',
    lastForwardErrorAt: bridge.lastForwardErrorAt || '',
    lastForwardOkAt: bridge.lastForwardOkAt || '',
    lastSessionId: bridge.lastSessionId || '',
    totalChats: chats.length,
    lastChatSessionId: lastChat?.sessionId || '',
    lastChatUpdatedAt: lastChat?.updatedAt || '',
  });
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\nAgroServer: http://127.0.0.1:${PORT}`);
    console.log(`Public dir: ${path.join(__dirname, 'public')}`);
    
    if (!SUPABASE_SERVICE_ROLE_KEY) {
        console.warn('\x1b[31m%s\x1b[0m', '[CRITICAL] SUPABASE_SERVICE_ROLE_KEY is missing!');
        console.warn('\x1b[33m%s\x1b[0m', 'Admin user synchronization will NOT function correctly until this key is added to .env.');
    } else {
        console.log('[OK] Supabase Service Role Key detected.');
    }

    if (!VK_GROUP_TOKEN) {
        console.warn('[VK] VK_GROUP_TOKEN не задан — сообщения с сайта в ВК не отправляются. Скопируйте .env.example → .env и заполните токен.');
    }
});
