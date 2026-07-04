// /api/db.js — Proxy Supabase de RESTAID. La clave vive SOLO aquí (variables
// de entorno), nunca en el navegador. Mismo patrón que claude.js / revo.js:
// autenticación por cabecera x-restaid-pass antes de reenviar.
//
// Variables de entorno (Vercel):
//   SUPABASE_URL          — ya existe (la usa login.js)
//   SUPABASE_SERVICE_KEY  — clave sb_secret_... (recomendada; ignora RLS)
//   SUPABASE_KEY          — fallback si aún no existe la service key
//   RESTAID_PASS          — ya existe
//
// Contrato (POST JSON):
//   { op:'get',    table, select?, order?, limit? }        → { ok, rows }
//   { op:'upsert', table, periodo?, datos, extra? }        → { ok, mode:'patch'|'insert' }
//   { op:'patch',  table, periodo?, datos }                → { ok, updated:boolean }
//
// El upsert hace PATCH y, si no actualizó ninguna fila, INSERT — en el
// servidor, para que los clientes hagan UNA llamada en vez de dos.

const TABLAS = ['ventas_productos', 'ventas_carta', 'ventas_escandallo', 'inventario', 'rrhh', 'appcc'];
const TABLAS_PERSONAL = ['rrhh', 'inventario']; // la app de fichaje solo necesita estas

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Método no permitido' });
    return;
  }

  // Cuerpo (Vercel suele parsearlo; si no, lo leemos en crudo)
  let body = req.body;
  if (!body || typeof body === 'string') {
    try {
      const raw = await new Promise((resolve, reject) => {
        let d = '';
        req.on('data', c => (d += c));
        req.on('end', () => resolve(d));
        req.on('error', reject);
      });
      body = raw ? JSON.parse(raw) : {};
    } catch (_) { body = {}; }
  }

  // ── Autenticación (misma convención que claude.js) ──
  const pass = req.headers['x-restaid-pass'] || '';
  const isPersonal = pass === 'personal';
  const isAdmin = !!process.env.RESTAID_PASS && pass === process.env.RESTAID_PASS;
  if (!isAdmin && !isPersonal) {
    res.status(401).json({ ok: false, error: 'No autorizado' });
    return;
  }

  const { op, table } = body || {};
  const permitidas = isAdmin ? TABLAS : TABLAS_PERSONAL;
  if (!table || !permitidas.includes(table)) {
    res.status(400).json({ ok: false, error: 'Tabla no permitida: ' + table });
    return;
  }

  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!SB_URL || !SB_KEY) {
    res.status(500).json({ ok: false, error: 'Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY en el servidor' });
    return;
  }

  const REST = 'default'; // restaurante único (TalaBar)
  const H = { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };

  try {
    // ── GET: lectura de filas ──
    if (op === 'get') {
      const select = /^[a-z_,]+$/.test(body.select || '') ? body.select : 'datos';
      const order = /^[a-z_]+\.(asc|desc)$/.test(body.order || '') ? '&order=' + body.order : '';
      const limit = Number.isInteger(body.limit) && body.limit > 0 && body.limit <= 100 ? body.limit : 50;
      const url = `${SB_URL}/rest/v1/${table}?restaurante=eq.${REST}&select=${select}${order}&limit=${limit}`;
      const r = await fetch(url, { headers: H });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        res.status(502).json({ ok: false, error: 'Supabase ' + r.status + ': ' + t.slice(0, 200) });
        return;
      }
      const rows = await r.json();
      res.status(200).json({ ok: true, rows });
      return;
    }

    // ── PATCH / UPSERT: escritura ──
    if (op === 'patch' || op === 'upsert') {
      if (body.datos === undefined) {
        res.status(400).json({ ok: false, error: 'Falta datos' });
        return;
      }
      const filtro = `restaurante=eq.${REST}` + (body.periodo ? `&periodo=eq.${encodeURIComponent(body.periodo)}` : '');
      const rPatch = await fetch(`${SB_URL}/rest/v1/${table}?${filtro}`, {
        method: 'PATCH',
        headers: { ...H, 'Prefer': 'return=representation' },
        body: JSON.stringify({ datos: body.datos })
      });
      const txt = await rPatch.text().catch(() => '');
      let patched = []; try { patched = JSON.parse(txt); } catch (_) {}
      const updated = Array.isArray(patched) && patched.length > 0;

      if (op === 'patch') {
        res.status(200).json({ ok: true, updated });
        return;
      }

      // upsert: si el PATCH no tocó filas, INSERT
      if (!updated) {
        const row = Object.assign({ restaurante: REST, datos: body.datos },
          body.periodo ? { periodo: body.periodo } : {},
          body.extra && typeof body.extra === 'object' ? body.extra : {});
        const rPost = await fetch(`${SB_URL}/rest/v1/${table}`, {
          method: 'POST',
          headers: { ...H, 'Prefer': 'return=minimal' },
          body: JSON.stringify(row)
        });
        if (!rPost.ok) {
          const t = await rPost.text().catch(() => '');
          res.status(502).json({ ok: false, error: 'Supabase insert ' + rPost.status + ': ' + t.slice(0, 200) });
          return;
        }
        res.status(200).json({ ok: true, mode: 'insert' });
        return;
      }
      res.status(200).json({ ok: true, mode: 'patch' });
      return;
    }

    res.status(400).json({ ok: false, error: 'op desconocida: ' + op });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'Error al contactar con Supabase' });
  }
};

module.exports.config = { maxDuration: 30 };
