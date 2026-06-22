// /api/login.js — Sin dependencias externas. Usa fetch directo a Supabase REST API.

const sbFetch = async (table, method = 'GET', body = null) => {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${table}`;
  const headers = {
    'apikey': process.env.SUPABASE_KEY,
    'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': method === 'POST' ? 'resolution=merge-duplicates' : 'return=representation'
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url + (method === 'GET' ? '?select=*' : ''), opts);
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Supabase ${table} error ${r.status}: ${err}`);
  }
  return r.json();
};

const readBody = (req) => new Promise((resolve, reject) => {
  if (req.body && typeof req.body === 'object') { resolve(req.body); return; }
  let d = '';
  req.on('data', c => (d += c));
  req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  req.on('error', reject);
});

module.exports = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const mode = url.searchParams.get('mode');
  const action = url.searchParams.get('action');

  const SB_OK = !!(process.env.SUPABASE_URL && process.env.SUPABASE_KEY);

  // ━━━━━━━━━━━━━━━━━ GET ━━━━━━━━━━━━━━━━━
  if (req.method === 'GET') {

    if (mode === 'personal') {
      if (!SB_OK) {
        res.status(200).json({ ok: true, db: { empleados: [], fichajes: [], albaranes: [], proveedores: [] }, error: 'Supabase no configurado' });
        return;
      }
      try {
        const [empleados, fichajes, proveedores] = await Promise.all([
          sbFetch('empleados'),
          sbFetch('fichajes'),
          sbFetch('proveedores')
        ]);
        console.log('DB personal — empleados:', empleados.length);
        res.status(200).json({ ok: true, db: { empleados, fichajes, albaranes: [], proveedores } });
      } catch (e) {
        console.error('Error GET personal:', e.message);
        res.status(200).json({ ok: true, db: { empleados: [], fichajes: [], albaranes: [], proveedores: [] }, error: e.message });
      }
      return;
    }

    res.status(200).json({ ok: false, userSet: !!process.env.RESTAID_USER, passSet: !!process.env.RESTAID_PASS, keySet: !!process.env.ANTHROPIC_API_KEY, sbSet: SB_OK });
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ ok: false }); return; }
  const body = await readBody(req);

  // ━━━━━━━━━━━━━━━━━ POST: sync fichajes ━━━━━━━━━━━━━━━━━
  if (mode === 'personal' && action === 'sync') {
    const { db } = body || {};
    if (SB_OK && db && db.fichajes && db.fichajes.length > 0) {
      try {
        const sbUrl = `${process.env.SUPABASE_URL}/rest/v1/fichajes`;
        await fetch(sbUrl, {
          method: 'POST',
          headers: {
            'apikey': process.env.SUPABASE_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates'
          },
          body: JSON.stringify(db.fichajes)
        });
      } catch (e) { console.error('Sync error:', e.message); }
    }
    res.status(200).json({ ok: true });
    return;
  }

  // ━━━━━━━━━━━━━━━━━ POST: aplicar albarán ━━━━━━━━━━━━━━━━━
  if (mode === 'personal' && action === 'aplicar_albaran') {
    const { albaran, provId, fecha } = body || {};
    if (!albaran || !provId) { res.status(400).json({ ok: false, msg: 'Datos incompletos' }); return; }
    if (!SB_OK) { res.status(500).json({ ok: false, msg: 'Supabase no configurado' }); return; }

    try {
      const alb_id = `alb_${Date.now()}`;
      const sbUrl = `${process.env.SUPABASE_URL}/rest/v1`;
      const headers = {
        'apikey': process.env.SUPABASE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      };

      // Guardar albarán
      await fetch(`${sbUrl}/albaranes`, {
        method: 'POST', headers,
        body: JSON.stringify({ id: alb_id, proveedor_id: provId, fecha: fecha || new Date().toISOString().slice(0, 10), productos: albaran.productos || [] })
      });

      // Guardar movimientos de stock
      if (albaran.productos && albaran.productos.length > 0) {
        const movimientos = albaran.productos.map(prod => ({
          id: `mov_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          tipo: 'entrada',
          cantidad: prod.cantidad * (prod.conversion_factor || 1),
          fecha: fecha || new Date().toISOString().slice(0, 10),
          concepto: `Albarán ${prod.nombre}`,
          proveedor_id: provId,
          nombre_producto: prod.nombre
        }));
        await fetch(`${sbUrl}/movimientos`, { method: 'POST', headers, body: JSON.stringify(movimientos) });
      }

      // Devolver DB actualizada
      const [empleados, fichajes, proveedores] = await Promise.all([
        sbFetch('empleados'), sbFetch('fichajes'), sbFetch('proveedores')
      ]);
      res.status(200).json({ ok: true, db: { empleados, fichajes, albaranes: [], proveedores } });
    } catch (e) {
      console.error('Error aplicar albarán:', e.message);
      res.status(500).json({ ok: false, msg: e.message });
    }
    return;
  }

  // ━━━━━━━━━━━━━━━━━ POST: login normal ━━━━━━━━━━━━━━━━━
  const { user, pass } = body || {};
  const ok = !!process.env.RESTAID_USER && !!process.env.RESTAID_PASS && user === process.env.RESTAID_USER && pass === process.env.RESTAID_PASS;
  res.status(ok ? 200 : 401).json({ ok });
};
