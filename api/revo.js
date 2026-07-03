// /api/revo.js — Proxy a la API de Revo XEF (Cegid).
// El Personal Token vive solo aquí (variable de entorno REVO_TOKEN),
// nunca en el navegador. Mismo patrón de auth que claude.js y db.js.
//
// Uso desde los módulos de RESTAID (GET):
//   fetch('/api/revo?resource=warehouses', { headers: { 'x-restaid-pass': PASS } })
//   fetch('/api/revo?resource=stocks', ...)
//   fetch('/api/revo?resource=orders&start=2025-01-01&end=2025-01-31', ...)
//   fetch('/api/revo?resource=catalog', ...)
//   fetch('/api/revo?resource=suppliers', ...)
//
// Todos los recursos son solo lectura (GET). RESTAID no escribe en Revo.

const BASE = 'https://api.integrations.revoxef.works';

// Mapa de recursos disponibles.
// Cada entrada define la ruta base en la API de Revo.
// Los parámetros de filtro (fechas, página...) se añaden dinámicamente.
const RESOURCES = {
  warehouses: '/classic/warehouses',
  stocks:     '/classic/stocks',
  orders:     '/classic/reports/orders',   // requiere start + end
  catalog:    '/classic/catalog/items',    // "items" = todos los tipos en uno (tip de Cegid)
  suppliers:  '/classic/purchase/suppliers',
  payments:   '/classic/payments/methods',
  staff:      '/classic/staff',
  tables:     '/classic/tables',
};

module.exports = async (req, res) => {
  // Solo GET
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Método no permitido (solo GET)' });
    return;
  }

  // Autorización: mismo patrón que claude.js (pass o modo personal)
  const pass = req.headers['x-restaid-pass'] || '';
  const isPersonal = pass === 'personal';
  if (!isPersonal && (!process.env.RESTAID_PASS || pass !== process.env.RESTAID_PASS)) {
    res.status(401).json({ error: 'No autorizado' });
    return;
  }

  const token = process.env.REVO_TOKEN;
  if (!token) {
    res.status(500).json({ error: 'Falta REVO_TOKEN en las variables de entorno de Vercel' });
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

  // Construimos los query params para Revo según el recurso
  const params = new URLSearchParams();

  if (resource === 'orders') {
    // Fechas obligatorias para el informe de ventas
    const start = req.query.start || '';
    const end   = req.query.end   || '';
    if (!start || !end) {
      res.status(400).json({ error: 'El recurso "orders" requiere los parámetros start y end (YYYY-MM-DD)' });
      return;
    }
    params.set('start_date', start);
    params.set('end_date', end);
    // Incluir detalles de contenido y pagos (útil para análisis de ventas)
    if (req.query.withContents)  params.set('withContents', '1');
    if (req.query.withPayments)  params.set('withPayments', '1');
    if (req.query.withInvoices)  params.set('withInvoices', '1');
  }

  // Paginación: todos los recursos la soportan
  if (req.query.page)     params.set('page', req.query.page);
  if (req.query.perPage)  params.set('per_page', req.query.perPage);

  // Filtros de stock: almacén concreto
  if (resource === 'stocks' && req.query.warehouseId) {
    params.set('warehouseId', req.query.warehouseId);
  }

  const qs = params.toString();
  const url = BASE + basePath + (qs ? '?' + qs : '');

  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/json',
      },
    });

    const text = await r.text();

    // Propagamos el status de Revo tal cual (200, 401, 404, 429...)
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
