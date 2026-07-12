// /api/revo_traductor.js — Traductor: revo_eventos → histórico limpio.
//
// Coge los eventos order.closed pendientes (procesado=false), los convierte
// en filas limpias (ventas_ordenes + ventas_lineas, hora española) y los
// marca como procesados. Idempotente: reprocesar no duplica (upsert por id).
//
// Uso: POST /api/revo_traductor?key=LA_LLAVE
//   (la llave se define en Vercel como RESTAID_TRADUCTOR_KEY)
// Respuesta: { ok, procesados, descartados, errores }
//
// Variables de entorno: SUPABASE_URL, SUPABASE_SERVICE_KEY (o SUPABASE_KEY),
// RESTAID_TRADUCTOR_KEY.
//
// Tablas (crear una vez en el SQL editor de Supabase — ver traductor_tablas.sql).

const crypto = require('crypto');

// ── Núcleo puro (testeado en test_traductor_core.js) ────────────────────

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
    orden_id: data.id,
    fecha: cerrado.fecha,
    jornada: jornadaDe(cerrado.ts),
    abierto: abierto ? abierto.ts : null,
    cerrado: cerrado.ts,
    duracion_min: duracion,
    comensales: Math.max(1, num(data.guests) || 1),
    mesa: data.tableName || null,
    mesa_id: data.table_id ?? null,
    empleado: data.tenantUserName || null,
    empleado_id: data.tenantUser_id ?? null,
    total: num(data.total),
    subtotal: num(data.subtotal),
    impuestos: num(data.taxAmount),
    descuento: num(data.discountAmount) + num(data.orderDiscountAmount),
    propina,
    metodo_pago: metodoPago,
    turno_revo: turnoRevo,
    reembolsada: !!data.refunded_invoice_id,
  };

  const contents = Array.isArray(data.orderContents) ? data.orderContents : [];
  const lineas = contents.map(c => ({
    linea_id: c.id,
    orden_id: data.id,
    fecha: cerrado.fecha,
    producto: c.itemName || '?',
    item_id: c.item_id ?? null,
    cantidad: num(c.quantity),
    precio_unit: num(c.itemPrice),
    total: num(c.total),
    subtotal: num(c.subtotal),
    impuestos: num(c.taxAmount),
    descuento: num(c.discountAmount),
    empleado_id: c.tenantUser_id ?? null,
    dish_order: c.dishOrder ?? null,
    marcado: (utcAMadrid(c.created_at) || {}).ts || null,
  }));

  return { orden, lineas };
}

// ── Acceso a Supabase ────────────────────────────────────────────────────

function sbHeaders(key) {
  return {
    'Content-Type': 'application/json',
    apikey: key,
    Authorization: `Bearer ${key}`,
  };
}

// ── Handler ──────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Método no permitido' });
    return;
  }

  const llave = (req.query && req.query.key) || req.headers['x-restaid-key'];
  const llaveOK = process.env.RESTAID_TRADUCTOR_KEY;
  if (!llaveOK || !llave || String(llave) !== String(llaveOK)) {
    res.status(401).json({ ok: false, error: 'Llave inválida' });
    return;
  }

  const URL_SB = process.env.SUPABASE_URL;
  const KEY_SB = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!URL_SB || !KEY_SB) {
    res.status(500).json({ ok: false, error: 'Supabase no configurado' });
    return;
  }

  try {
    // 1. Leer pendientes (máx 200 por pasada para no eternizar la función)
    const rPend = await fetch(
      `${URL_SB}/rest/v1/revo_eventos?procesado=eq.false&event=eq.order.closed&order=id.asc&limit=200`,
      { headers: sbHeaders(KEY_SB) }
    );
    if (!rPend.ok) throw new Error('leyendo pendientes: HTTP ' + rPend.status);
    const pendientes = await rPend.json();

    let procesados = 0, descartados = 0;
    const errores = [];
    const idsOK = [];

    for (const ev of pendientes) {
      try {
        const t = transformarEvento(ev.data);
        if (!t) {
          // Cierre intermedio o cancelada: no entra al histórico,
          // pero se marca procesado para no revisarlo eternamente.
          descartados++;
          idsOK.push(ev.id);
          continue;
        }

        // 2. Upsert de la orden (idempotente por orden_id)
        const rO = await fetch(
          `${URL_SB}/rest/v1/ventas_ordenes?on_conflict=orden_id`,
          {
            method: 'POST',
            headers: { ...sbHeaders(KEY_SB), Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify([t.orden]),
          }
        );
        if (!rO.ok) throw new Error('orden ' + t.orden.orden_id + ': HTTP ' + rO.status + ' ' + (await rO.text().catch(() => '')));

        // 3. Upsert de las líneas (idempotente por linea_id)
        if (t.lineas.length) {
          const rL = await fetch(
            `${URL_SB}/rest/v1/ventas_lineas?on_conflict=linea_id`,
            {
              method: 'POST',
              headers: { ...sbHeaders(KEY_SB), Prefer: 'resolution=merge-duplicates,return=minimal' },
              body: JSON.stringify(t.lineas),
            }
          );
          if (!rL.ok) throw new Error('lineas orden ' + t.orden.orden_id + ': HTTP ' + rL.status);
        }

        procesados++;
        idsOK.push(ev.id);
      } catch (e) {
        // Un evento problemático no bloquea al resto; queda pendiente
        // para la siguiente pasada y anotamos el motivo.
        errores.push({ evento_id: ev.id, error: String(e.message || e).slice(0, 200) });
      }
    }

    // 4. Marcar procesados (solo los que fueron bien o se descartaron)
    if (idsOK.length) {
      const rM = await fetch(
        `${URL_SB}/rest/v1/revo_eventos?id=in.(${idsOK.join(',')})`,
        {
          method: 'PATCH',
          headers: { ...sbHeaders(KEY_SB), Prefer: 'return=minimal' },
          body: JSON.stringify({ procesado: true }),
        }
      );
      if (!rM.ok) throw new Error('marcando procesados: HTTP ' + rM.status);
    }

    console.log(`[revo_traductor] procesados=${procesados} descartados=${descartados} errores=${errores.length}`);
    res.status(200).json({ ok: true, procesados, descartados, errores });
  } catch (e) {
    console.error('[revo_traductor] fallo:', e.message || e);
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
};
