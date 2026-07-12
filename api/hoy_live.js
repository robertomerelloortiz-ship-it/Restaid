// /api/hoy_live.js — El "hoy" en tiempo real para el dashboard (index.html).
//
// Devuelve en una sola llamada ligera:
//   - cerradas: suma de las órdenes CERRADAS hoy (piso 2, fecha local Madrid)
//   - abiertas: las mesas abiertas AHORA MISMO (tabla revo_abiertas,
//     mantenida por el webhook con order.created/updated)
//
// Antes de leer, procesa los eventos order.closed pendientes (traductor
// integrado, lote corto) para que las cerradas estén al segundo.
//
// Uso: GET /api/hoy_live  →
//   { ok, fecha, cerradas:{euros,n,comensales}, abiertas:{euros,n,comensales,mesas:[...]} }

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
function hoyMadrid() { return FMT.format(new Date()).replace(',', '').slice(0, 10); }

// Jornada de SERVICIO (criterio Revo y de la casa): la madrugada pertenece
// al día anterior. CORTE_JORNADA_H = 4 → el día acaba a las 04:00 (las cenas
// se alargan hasta la 01:30; entre las 04:00 y la apertura no hay actividad).
// Convención única de Talabar: si algún día cambia, cambiarla SOLO aquí.
function jornadaServicio() {
  const ts = FMT.format(new Date(Date.now() - CORTE_JORNADA_H * 3600 * 1000)).replace(',', '');
  const fecha = ts.slice(0, 10);
  const hh = String(CORTE_JORNADA_H).padStart(2, '0');
  return {
    fecha,                                  // etiqueta de la jornada
    desde: fecha + ' ' + hh + ':00:00',     // ventana de cierres que le pertenecen
    hasta: null,                            // hasta ahora mismo
  };
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
    `${URL_SB}/rest/v1/revo_eventos?procesado=eq.false&event=eq.order.closed&order=id.asc&limit=50`,
    { headers: sbHeaders(KEY_SB) }
  );
  if (!r.ok) return;
  const pendientes = await r.json();
  const idsOK = [];
  for (const ev of pendientes) {
    try {
      const t = transformarEvento(ev.data);
      if (!t) { idsOK.push(ev.id); continue; }
      const rO = await fetch(`${URL_SB}/rest/v1/ventas_ordenes?on_conflict=orden_id`, {
        method: 'POST',
        headers: { ...sbHeaders(KEY_SB), Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([t.orden]),
      });
      if (!rO.ok) continue;
      if (t.lineas.length) {
        const rL = await fetch(`${URL_SB}/rest/v1/ventas_lineas?on_conflict=linea_id`, {
          method: 'POST',
          headers: { ...sbHeaders(KEY_SB), Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(t.lineas),
        });
        if (!rL.ok) continue;
      }
      idsOK.push(ev.id);
    } catch (_) { /* siguiente */ }
  }
  if (idsOK.length) {
    await fetch(`${URL_SB}/rest/v1/revo_eventos?id=in.(${idsOK.join(',')})`, {
      method: 'PATCH',
      headers: { ...sbHeaders(KEY_SB), Prefer: 'return=minimal' },
      body: JSON.stringify({ procesado: true }),
    }).catch(() => {});
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ ok: false, error: 'Solo GET' }); return; }
  const URL_SB = process.env.SUPABASE_URL;
  const KEY_SB = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!URL_SB || !KEY_SB) { res.status(500).json({ ok: false, error: 'Supabase no configurado' }); return; }
  try {
    await procesarPendientes(URL_SB, KEY_SB);
    // Jornada de servicio (corte 04:00): se consulta por la columna jornada
    const j = jornadaServicio();
    const fecha = j.fecha;
    const ayerJ = (() => { const d = new Date(fecha + 'T12:00:00'); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
    const [rC, rA, rY] = await Promise.all([
      fetch(`${URL_SB}/rest/v1/ventas_ordenes?select=total,comensales&jornada=eq.${fecha}&limit=2000`, { headers: sbHeaders(KEY_SB) }),
      fetch(`${URL_SB}/rest/v1/revo_abiertas?select=orden_id,mesa,comensales,empleado,total,abierta_desde&order=abierta_desde.asc&limit=200`, { headers: sbHeaders(KEY_SB) }),
      fetch(`${URL_SB}/rest/v1/ventas_ordenes?select=total,comensales&jornada=eq.${ayerJ}&limit=2000`, { headers: sbHeaders(KEY_SB) }),
    ]);
    if (!rC.ok) throw new Error('cerradas: HTTP ' + rC.status);
    const cerradasFilas = await rC.json();
    const abiertasFilas = rA.ok ? await rA.json() : [];
    const ayerFilas = rY.ok ? await rY.json() : [];

    const cerradas = {
      euros: Math.round(cerradasFilas.reduce((s, o) => s + num(o.total), 0) * 100) / 100,
      n: cerradasFilas.length,
      comensales: cerradasFilas.reduce((s, o) => s + (o.comensales || 0), 0),
    };
    const abiertas = {
      euros: Math.round(abiertasFilas.reduce((s, o) => s + num(o.total), 0) * 100) / 100,
      n: abiertasFilas.length,
      comensales: abiertasFilas.reduce((s, o) => s + (o.comensales || 0), 0),
      mesas: abiertasFilas.map(o => ({
        mesa: o.mesa, total: num(o.total), comensales: o.comensales,
        desde: o.abierta_desde ? String(o.abierta_desde).slice(11, 16) : null,
      })),
    };
    const ayer = {
      fecha: ayerJ,
      euros: Math.round(ayerFilas.reduce((s, o) => s + num(o.total), 0) * 100) / 100,
      n: ayerFilas.length,
      comensales: ayerFilas.reduce((s, o) => s + (o.comensales || 0), 0),
    };
    res.status(200).json({ ok: true, fecha, cerradas, abiertas, ayer });
  } catch (e) {
    console.error('[hoy_live] fallo:', e.message || e);
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
};
