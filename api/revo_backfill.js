// /api/revo_backfill.js — Relleno de huecos del histórico desde la API de Revo.
//
// Pide las órdenes cerradas de un rango de fechas al endpoint de reports de
// Revo (el mismo detalle que el webhook) y las mete en el piso 2
// (ventas_ordenes / ventas_lineas) por el MISMO traductor. Idempotente:
// relanzarlo sobre el mismo rango no duplica nada (upsert por id).
//
// Uso:
//   ENSAYO (no escribe nada, muestra qué haría):
//     GET /api/revo_backfill?desde=2026-07-01&hasta=2026-07-11&key=LA_LLAVE&dry=1
//   REAL:
//     GET /api/revo_backfill?desde=2026-07-01&hasta=2026-07-11&key=LA_LLAVE
//
// El modo ensayo devuelve la primera orden CRUDA de Revo y su transformación,
// para verificar con datos reales (zona horaria, campos) antes de escribir.
//
// Reutiliza la autenticación de /api/revo.js (REVO_TOKEN + REVO_TENANT) y
// la llave del traductor (RESTAID_TRADUCTOR_KEY).

const TZ = 'Europe/Madrid';
const FMT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

function utcAMadrid(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return null;
  const ts = FMT.format(d).replace(',', '');
  const [fecha, hora] = ts.split(' ');
  return { fecha, hora, ts: fecha + ' ' + hora, date: d };
}

function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

function transformarEvento(data) {
  if (!data || !data.id) return null;
  if (data.status !== 1) return null;
  if (data.canceled) return null;
  const cerrado = utcAMadrid(data.closed || data.updated_at);
  const abierto = utcAMadrid(data.opened || data.created_at);
  if (!cerrado) return null;
  const duracion = abierto ? Math.round((cerrado.date - abierto.date) / 60000) : null;
  let metodoPago = null, turnoRevo = null, propina = 0;
  const invoices = Array.isArray(data.orderInvoices) ? data.orderInvoices : [];
  for (const inv of invoices) {
    const pagos = Array.isArray(inv.orderPayments) ? inv.orderPayments : [];
    if (pagos.length) {
      metodoPago = pagos[0].paymentMethod ?? null;
      turnoRevo = pagos[0].turn_id ?? null;
      propina = pagos.reduce((s, p) => s + num(p.tipAmount), 0);
      break;
    }
  }
  const orden = {
    orden_id: data.id, fecha: cerrado.fecha,
    abierto: abierto ? abierto.ts : null, cerrado: cerrado.ts,
    duracion_min: duracion,
    comensales: Math.max(1, num(data.guests) || 1),
    mesa: data.tableName || null, mesa_id: data.table_id ?? null,
    empleado: data.tenantUserName || null, empleado_id: data.tenantUser_id ?? null,
    total: num(data.total), subtotal: num(data.subtotal), impuestos: num(data.taxAmount),
    descuento: num(data.discountAmount) + num(data.orderDiscountAmount),
    propina, metodo_pago: metodoPago, turno_revo: turnoRevo,
    reembolsada: !!data.refunded_invoice_id,
  };
  const contents = Array.isArray(data.orderContents) ? data.orderContents : [];
  const lineas = contents.map(c => ({
    linea_id: c.id, orden_id: data.id, fecha: cerrado.fecha,
    producto: c.itemName || '?', item_id: c.item_id ?? null,
    cantidad: num(c.quantity), precio_unit: num(c.itemPrice),
    total: num(c.total), subtotal: num(c.subtotal), impuestos: num(c.taxAmount),
    descuento: num(c.discountAmount), empleado_id: c.tenantUser_id ?? null,
    dish_order: c.dishOrder ?? null,
    marcado: (utcAMadrid(c.created_at) || {}).ts || null,
  }));
  return { orden, lineas };
}

function sbHeaders(key) {
  return { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` };
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Solo GET' });
    return;
  }
  const llave = (req.query && req.query.key) || req.headers['x-restaid-key'];
  if (!process.env.RESTAID_TRADUCTOR_KEY || llave !== process.env.RESTAID_TRADUCTOR_KEY) {
    res.status(401).json({ ok: false, error: 'Llave inválida' });
    return;
  }

  const desde = (req.query && req.query.desde) || '';
  const hasta = (req.query && req.query.hasta) || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
    res.status(400).json({ ok: false, error: 'Faltan desde/hasta (YYYY-MM-DD)' });
    return;
  }
  const dry = String((req.query && req.query.dry) || '') === '1';

  const token = process.env.REVO_TOKEN;
  if (!token) { res.status(500).json({ ok: false, error: 'Falta REVO_TOKEN' }); return; }
  const isLegacy = token.length < 50;
  const BASE = isLegacy ? 'https://revoxef.works' : 'https://api.integrations.revoxef.works';
  const PATH = isLegacy ? '/api/external/v3/reports/orders' : '/classic/reports/v3/orders';
  if (isLegacy && !process.env.REVO_TENANT) {
    res.status(500).json({ ok: false, error: 'Token legacy: falta REVO_TENANT' });
    return;
  }
  const revoHeaders = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
  if (isLegacy) revoHeaders.tenant = process.env.REVO_TENANT;

  const URL_SB = process.env.SUPABASE_URL;
  const KEY_SB = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!dry && (!URL_SB || !KEY_SB)) {
    res.status(500).json({ ok: false, error: 'Supabase no configurado' });
    return;
  }

  try {
    // ── 1. Descargar el rango de Revo, paginando ──
    const ordenesCrudas = [];
    let page = 1;
    const MAX_PAGES = 30;
    let debugPrimera = null; // diagnóstico: qué se llamó y qué contestó Revo
    while (page <= MAX_PAGES) {
      const qs = new URLSearchParams({
        start_date: desde, end_date: hasta,
        withContents: '1', withPayments: '1', withInvoices: '1',
        page: String(page), per_page: '100',
      });
      const r = await fetch(`${BASE}${PATH}?${qs}`, { headers: revoHeaders });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`Revo HTTP ${r.status} (página ${page}): ${t.slice(0, 200)}`);
      }
      const texto = await r.text();
      let cuerpo = {};
      try { cuerpo = JSON.parse(texto); } catch (_) { cuerpo = {}; }
      if (page === 1) {
        debugPrimera = {
          url: `${BASE}${PATH}?${qs}`,
          http: r.status,
          claves_respuesta: cuerpo && typeof cuerpo === 'object' ? Object.keys(cuerpo).slice(0, 15) : typeof cuerpo,
          primeros_400_chars: texto.slice(0, 400),
        };
      }
      // La respuesta puede venir como array plano o como {data:[...]} (Laravel)
      const lote = Array.isArray(cuerpo) ? cuerpo : Array.isArray(cuerpo.data) ? cuerpo.data : [];
      ordenesCrudas.push(...lote);
      const hayMas = lote.length === 100 ||
        (cuerpo.meta && cuerpo.meta.current_page < cuerpo.meta.last_page) ||
        (cuerpo.links && cuerpo.links.next);
      if (!hayMas || !lote.length) break;
      page++;
    }

    // ── 2. Transformar ──
    let convertidas = 0, descartadas = 0;
    const transformadas = [];
    for (const cruda of ordenesCrudas) {
      const t = transformarEvento(cruda);
      if (t) { transformadas.push(t); convertidas++; }
      else descartadas++;
    }

    // ── 3. Modo ensayo: enseñar, no escribir ──
    if (dry) {
      res.status(200).json({
        ok: true, modo: 'ENSAYO (no se ha escrito nada)',
        rango: { desde, hasta },
        recibidas_de_revo: ordenesCrudas.length,
        convertibles: convertidas,
        descartadas,
        muestra_cruda: ordenesCrudas[0] ? {
          id: ordenesCrudas[0].id, opened: ordenesCrudas[0].opened,
          closed: ordenesCrudas[0].closed, status: ordenesCrudas[0].status,
          total: ordenesCrudas[0].total, tableName: ordenesCrudas[0].tableName,
          n_contents: (ordenesCrudas[0].orderContents || []).length,
          n_invoices: (ordenesCrudas[0].orderInvoices || []).length,
        } : null,
        muestra_transformada: transformadas[0] ? transformadas[0].orden : null,
        diagnostico: debugPrimera,
      });
      return;
    }

    // ── 4. Escritura real (upsert idempotente, por lotes de 50 órdenes) ──
    let guardadas = 0;
    const errores = [];
    for (let i = 0; i < transformadas.length; i += 50) {
      const lote = transformadas.slice(i, i + 50);
      const rO = await fetch(`${URL_SB}/rest/v1/ventas_ordenes?on_conflict=orden_id`, {
        method: 'POST',
        headers: { ...sbHeaders(KEY_SB), Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(lote.map(t => t.orden)),
      });
      if (!rO.ok) { errores.push('ordenes lote ' + i + ': HTTP ' + rO.status); continue; }
      const lineas = lote.flatMap(t => t.lineas);
      if (lineas.length) {
        const rL = await fetch(`${URL_SB}/rest/v1/ventas_lineas?on_conflict=linea_id`, {
          method: 'POST',
          headers: { ...sbHeaders(KEY_SB), Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(lineas),
        });
        if (!rL.ok) { errores.push('lineas lote ' + i + ': HTTP ' + rL.status); continue; }
      }
      guardadas += lote.length;
    }

    console.log(`[revo_backfill] ${desde}→${hasta}: recibidas=${ordenesCrudas.length} guardadas=${guardadas} descartadas=${descartadas} errores=${errores.length}`);
    res.status(200).json({ ok: true, rango: { desde, hasta }, recibidas_de_revo: ordenesCrudas.length, guardadas, descartadas, errores });
  } catch (e) {
    console.error('[revo_backfill] fallo:', e.message || e);
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
};
