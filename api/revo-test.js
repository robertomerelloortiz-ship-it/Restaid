// /api/revo-test.js — PRUEBA TEMPORAL de conexión con Revo XEF.
// Objetivo: confirmar que el Personal Token (OAuth2) autentica correctamente
// contra la API clásica, ANTES de tocar restaid_ventas.html.
//
// El token vive solo aquí, como variable de entorno REVO_TOKEN (nunca en el navegador).
// Este archivo es desechable: una vez confirmemos que conecta, se borra y se
// construye el proxy definitivo api/revo.js.
//
// Uso desde el navegador (estando logueado en RESTAID no hace falta):
//   https://restaid.vercel.app/api/revo-test
//   (opcional) ?report=stocks   para probar otro endpoint
//
// Protegido con la misma contraseña que el resto (header x-restaid-pass),
// pero para poder abrirlo cómodamente desde el navegador durante la prueba,
// también acepta ?pass=TU_CONTRASEÑA como parámetro de URL.

module.exports = async (req, res) => {
  // --- Gate de contraseña (igual patrón que el resto de RESTAID) ---
  const pass = req.headers['x-restaid-pass'] || (req.query && req.query.pass) || '';
  if (!process.env.RESTAID_PASS || pass !== process.env.RESTAID_PASS) {
    res.status(401).json({ ok: false, error: 'No autorizado (falta contraseña correcta)' });
    return;
  }

  const token = process.env.REVO_TOKEN;
  if (!token) {
    res.status(500).json({ ok: false, error: 'Falta REVO_TOKEN en las variables de entorno de Vercel' });
    return;
  }

  // Entorno de TEST. Cuando pasemos a producción, cambiar por api.revoxef.works
  const BASE = 'https://api.integrations.revoxef.works';

  // Tenant opcional: solo se usa si lo hemos definido en Vercel.
  const tenant = process.env.REVO_TENANT || '';

  // Elegimos un endpoint de lectura muy simple para la prueba.
  // Por defecto: almacenes (classic.warehouses) — respuesta pequeña y clara.
  // Se puede cambiar con ?report=stocks | warehouses | reports
  const which = (req.query && req.query.report) || 'warehouses';
  const paths = {
    warehouses: '/api/external/v2/warehouses',
    stocks:     '/api/external/v2/stocks',
    reports:    '/api/external/v3/reports/orders?start_date=' +
                todayISO() + '&end_date=' + todayISO(),
  };
  const path = paths[which] || paths.warehouses;
  const url = BASE + path;

  // Construimos las cabeceras. Empezamos por lo mínimo que pide la doc nueva:
  // Authorization Bearer + Accept. Añadimos tenant solo si está definido.
  const headers = {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/json',
  };
  if (tenant) headers['tenant'] = tenant;

  try {
    const r = await fetch(url, { method: 'GET', headers });
    const raw = await r.text();

    // Intentamos parsear como JSON para devolver algo legible.
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { /* no era JSON */ }

    res.status(200).json({
      ok: r.ok,
      status: r.status,
      probado: {
        url,
        report: which,
        tenant_enviado: tenant || '(ninguno)',
      },
      // Si conectó, muestra los datos; si falló, muestra el mensaje de Revo
      // para saber exactamente qué header o permiso falta.
      respuesta: parsed !== null ? parsed : raw.slice(0, 2000),
    });
  } catch (e) {
    res.status(502).json({
      ok: false,
      error: 'No se pudo contactar con Revo',
      detalle: String(e && e.message || e),
      url,
    });
  }
};

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

module.exports.config = { maxDuration: 30 };
