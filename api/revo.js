// /api/revo.js — Proxy a la API de Revo XEF (Cegid).
// El token vive solo aquí (variable de entorno REVO_TOKEN),
// nunca en el navegador. Mismo patrón de auth que claude.js y db.js.
//
// Soporta dos modos de autenticación AUTO-DETECTADOS por longitud del token:
//
//   A) OAuth2 Personal Token (largo, ~200+ chars)
//      - BASE: https://api.integrations.revoxef.works
//      - Rutas: /classic/...
//      - Headers: Authorization: Bearer {token}, Accept: application/json
//
//   B) Legacy API Token (corto, ~16 chars)
//      - BASE: https://revoxef.works
//      - Rutas: /api/external/v3/reports/... y /api/external/v2/...
//      - Headers: tenant: {REVO_TENANT}, Authorization: Bearer {token}
//      - Requiere variable REVO_TENANT (nombre de la cuenta, ej: "talabar")
//
// Uso desde los módulos de RESTAID (GET):
//   fetch('/api/revo?resource=orders&start=2025-01-01&end=2025-01-31', ...)

// ── Modo OAuth2 ──
const BASE_OAUTH = 'https://api.integrations.revoxef.works';
const RESOURCES_OAUTH = {
  warehouses: '/classic/warehouses',
  stocks:     '/classic/stocks',
  orders:     '/classic/reports/v3/orders',
  catalog:    '/classic/catalog/items',
  suppliers:  '/classic/purchase/suppliers',
  payments:   '/classic/payments/methods',
  staff:      '/classic/staff',
  tables:     '/classic/tables',
};

// ── Modo Legacy ──
const BASE_LEGACY = 'https://revoxef.works';
const RESOURCES_LEGACY = {
  warehouses: '/api/external/v2/warehouses',
  stocks:     '/api/external/v2/stocks',
  orders:     '/api/external/v3/reports/orders',
  catalog:    '/api/external/v2/catalog/items',
  suppliers:  '/api/external/v2/purchase/suppliers',
  payments:   '/api/external/v2/payments/methods',
  staff:      '/api/external/v2/staff',
  tables:     '/api/external/v2/tables',
};

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Método no permitido (solo GET)' });
    return;
  }

  // Autorización RESTAID (misma convención que claude.js y login.js)
  const pass = req.headers['x-restaid-pass'] || '';
  if (!process.env.RESTAID_PASS || pass !== process.env.RESTAID_PASS) {
    res.status(401).json({ error: 'No autorizado' });
    return;
  }

  const token = process.env.REVO_TOKEN;
  if (!token) {
    res.status(500).json({ error: 'Falta REVO_TOKEN en las variables de entorno de Vercel' });
    return;
  }

  // Auto-detectar modo por longitud del token
  const isLegacy = token.length < 50;
  const BASE = isLegacy ? BASE_LEGACY : BASE_OAUTH;
  const RESOURCES = isLegacy ? RESOURCES_LEGACY : RESOURCES_OAUTH;

  if (isLegacy && !process.env.REVO_TENANT) {
    res.status(500).json({ error: 'Token legacy detectado: falta REVO_TENANT (nombre de cuenta, ej: "talabar")' });
    return;
  }

  // Recurso solicitado
  const resource = (req.query && req.query.resource) || '';
  const basePath = RESOURCES[resource];
  if (!basePath) {
    res.status(400).json({
      error: `Recurso desconocido: "${resource}". Disponibles: ${Object.keys(RESOURCES).join(', ')}`
    });
    return;
  }

  // Query params
  const params = new URLSearchParams();

  if (resource === 'orders') {
    const start = req.query.start || '';
    const end   = req.query.end   || '';
    if (!start || !end) {
      res.status(400).json({ error: 'El recurso "orders" requiere start y end (YYYY-MM-DD)' });
      return;
    }
    params.set('start_date', start);
    params.set('end_date', end);
    if (req.query.withContents)  params.set('withContents', '1');
    if (req.query.withPayments)  params.set('withPayments', '1');
    if (req.query.withInvoices)  params.set('withInvoices', '1');
  }

  if (req.query.page)     params.set('page', req.query.page);
  if (req.query.perPage)  params.set('per_page', req.query.perPage);

  if (resource === 'stocks' && req.query.warehouseId) {
    params.set('warehouseId', req.query.warehouseId);
  }

  const qs = params.toString();
  const url = BASE + basePath + (qs ? '?' + qs : '');

  // Cabeceras según modo
  const headers = {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/json',
  };
  if (isLegacy) {
    headers['tenant'] = process.env.REVO_TENANT;
  }

  try {
    const r = await fetch(url, { method: 'GET', headers });
    const text = await r.text();
    res.status(r.status);
    res.setHeader('Content-Type', 'application/json');
    res.send(text);
  } catch (e) {
    res.status(502).json({
      error: 'No se pudo contactar con Revo XEF',
      detalle: String(e && e.message || e),
    });
  }
};

module.exports.config = { maxDuration: 30 };
