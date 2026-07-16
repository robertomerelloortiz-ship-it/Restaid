// /api/ventas_live.js — Sirve el histórico en vivo al módulo de Ventas.
//
// En una sola llamada:
//   1. Procesa los eventos pendientes de revo_eventos (traductor integrado,
//      misma lógica que /api/revo_traductor) — así el módulo siempre recibe
//      los datos al día sin que nadie tenga que ejecutar nada a mano.
//   2. Devuelve las órdenes y líneas del piso 2 con fecha POSTERIOR a
//      `desde` (parámetro; normalmente el último día cubierto por la era CSV).
//
// Uso: GET /api/ventas_live?desde=2026-07-06
// Respuesta: { ok, ordenes: [...], lineas: [...], traductor: {procesados, descartados} }
//
// Sigue el patrón de los demás endpoints del proyecto (abierto como /api/db;
// solo lectura de ventas + procesado interno idempotente).

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


// Jornada de servicio (convención Talabar): el día acaba a las 04:00.
// Un cierre a la 01:30 pertenece a la jornada del día anterior.
const CORTE_JORNADA_H = 4;
function jornadaDe(cerradoTs) {
  if (!cerradoTs) return null;
  const d = new Date(String(cerradoTs).replace(' ', 'T'));
  if (isNaN(d)) return null;
  d.setHours(d.getHours() - CORTE_JORNADA_H);
  // fecha local del reloj retrasado (sin pasar por UTC para no mover el día)
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

function transformarEvento(data) {
  if (!data || !data.id) return null;
  // status 0 con total 0 = cierre intermedio (descartar). status 0 con dinero
  // = venta rápida REAL (caso 242713, verificado 12-jul-2026): se procesa.
  if (data.status !== 1 && num(data.total) <= 0) return null;
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
    jornada: jornadaDe(cerrado.ts),
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

async function procesarPendientes(URL_SB, KEY_SB) {
  const r = await fetch(
    `${URL_SB}/rest/v1/revo_eventos?procesado=eq.false&event=eq.order.closed&order=id.asc&limit=200`,
    { headers: sbHeaders(KEY_SB) }
  );
  if (!r.ok) return { procesados: 0, descartados: 0, error: 'HTTP ' + r.status };
  const pendientes = await r.json();
  let procesados = 0, descartados = 0;
  const idsOK = [];
  for (const ev of pendientes) {
    try {
      const t = transformarEvento(ev.data);
      if (!t) { descartados++; idsOK.push(ev.id); continue; }
      const rO = await fetch(`${URL_SB}/rest/v1/ventas_ordenes?on_conflict=orden_id`, {
        method: 'POST',
        headers: { ...sbHeaders(KEY_SB), Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([t.orden]),
      });
      if (!rO.ok) continue; // queda pendiente para la próxima
      if (t.lineas.length) {
        const rL = await fetch(`${URL_SB}/rest/v1/ventas_lineas?on_conflict=linea_id`, {
          method: 'POST',
          headers: { ...sbHeaders(KEY_SB), Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(t.lineas),
        });
        if (!rL.ok) continue;
      }
      procesados++; idsOK.push(ev.id);
    } catch (_) { /* siguiente */ }
  }
  if (idsOK.length) {
    await fetch(`${URL_SB}/rest/v1/revo_eventos?id=in.(${idsOK.join(',')})`, {
      method: 'PATCH',
      headers: { ...sbHeaders(KEY_SB), Prefer: 'return=minimal' },
      body: JSON.stringify({ procesado: true }),
    }).catch(() => {});
  }
  return { procesados, descartados };
}

// ── Autorización ─────────────────────────────────────────────────────────
// Este endpoint devuelve el histórico de órdenes y líneas: nunca debe ser
// público. Acepta la contraseña del local (x-restaid-pass) o el secreto del
// grupo (x-restaid-grupo) para lecturas de servidor a servidor entre locales.
function autorizado(req) {
  const pass = req.headers['x-restaid-pass'] || '';
  if (process.env.RESTAID_PASS && pass === process.env.RESTAID_PASS) return true;
  const grupo = req.headers['x-restaid-grupo'] || '';
  if (process.env.GRUPO_TOKEN && grupo === process.env.GRUPO_TOKEN) return true;
  return false;
}

module.exports = async (req, res) => {
  if (!autorizado(req)) { res.status(401).json({ ok: false, error: 'No autorizado' }); return; }
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Solo GET' });
    return;
  }
  const URL_SB = process.env.SUPABASE_URL;
  const KEY_SB = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!URL_SB || !KEY_SB) {
    res.status(500).json({ ok: false, error: 'Supabase no configurado' });
    return;
  }
  try {
    // 1. Poner el piso 2 al día
    const traductor = await procesarPendientes(URL_SB, KEY_SB);

    // 2. Devolver las filas desde la fecha de corte + el mapa de categorías
    //    del catálogo (fuente de verdad para clasificar cocina/bebida)
    const desde = (req.query && req.query.desde) || '';
    const filtro = /^\d{4}-\d{2}-\d{2}$/.test(desde) ? `&fecha=gt.${desde}` : '';
    const cols = 'select=*';
    const [rO, rL, rC] = await Promise.all([
      fetch(`${URL_SB}/rest/v1/ventas_ordenes?${cols}${filtro}&order=fecha.asc&limit=20000`, { headers: sbHeaders(KEY_SB) }),
      fetch(`${URL_SB}/rest/v1/ventas_lineas?${cols}${filtro}&order=fecha.asc&limit=100000`, { headers: sbHeaders(KEY_SB) }),
      fetch(`${URL_SB}/rest/v1/revo_catalogo?select=producto,categoria&limit=10000`, { headers: sbHeaders(KEY_SB) }),
    ]);
    if (!rO.ok || !rL.ok) throw new Error('leyendo piso 2: HTTP ' + rO.status + '/' + rL.status);
    const ordenes = await rO.json();
    const lineas = await rL.json();
    // El catálogo es opcional: si la tabla no existe aún, seguimos sin él
    let categorias = {};
    if (rC.ok) {
      try {
        for (const c of await rC.json()) {
          if (c.producto && c.categoria) categorias[c.producto] = c.categoria;
        }
      } catch (_) { categorias = {}; }
    }
    console.log(`[ventas_live] traductor=${JSON.stringify(traductor)} ordenes=${ordenes.length} lineas=${lineas.length} categorias=${Object.keys(categorias).length} desde=${desde || '(todo)'}`);
    res.status(200).json({ ok: true, ordenes, lineas, categorias, traductor });
  } catch (e) {
    console.error('[ventas_live] fallo:', e.message || e);
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
};
