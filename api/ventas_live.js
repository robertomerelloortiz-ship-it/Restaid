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
// Las cabeceras HTTP viajan en Latin-1: una contraseña con ñ o tildes llega
// alterada (p. ej. "caÃ±illa") aunque el login (que va en el cuerpo, UTF-8)
// funcione. Se compara también la forma reparada y sin espacios sobrantes.
function coincide(recibido, esperado) {
  if (!esperado) return false;
  const cands = new Set([recibido, String(recibido).trim()]);
  try { cands.add(Buffer.from(recibido, 'latin1').toString('utf8')); } catch (e) {}
  try { cands.add(decodeURIComponent(recibido)); } catch (e) {}
  return cands.has(esperado) || cands.has(esperado.trim());
}
function autorizado(req) {
  if (coincide(req.headers['x-restaid-pass'] || '', process.env.RESTAID_PASS)) return true;
  if (coincide(req.headers['x-restaid-grupo'] || '', process.env.GRUPO_TOKEN)) return true;
  return false;
}

// ── Servicios del día (turnos) por local ──────────────────────────────────
// Cada negocio define los suyos en la variable de entorno TURNOS_SERVICIOS
// de SU despliegue de Vercel (JSON, mismo formato que CFG.turnos del módulo):
//   {"Desayuno":{"ini":6,"fin":12,"horas":4},"Comida":{"ini":12,"fin":17,"horas":5},"Cena":{"ini":17,"fin":24,"horas":5}}
// Sin variable (o con JSON inválido) se devuelve null y el módulo de Ventas
// usa su defecto de siempre (Comida/Cena) — Talabar no necesita configurar nada.
function parsearTurnosEnv(raw) {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw);
    if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
    const nombres = Object.keys(t);
    if (!nombres.length) return null;
    for (const n of nombres) {
      const f = t[n];
      if (!f || typeof f.ini !== 'number' || typeof f.fin !== 'number') return null;
    }
    return t;
  } catch (e) { return null; }
}

module.exports = async (req, res) => {
  if (!autorizado(req)) { res.status(401).json({ ok: false, error: 'No autorizado' }); return; }

  const URL_SB = process.env.SUPABASE_URL;
  const KEY_SB = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!URL_SB || !KEY_SB) {
    res.status(500).json({ ok: false, error: 'Supabase no configurado' });
    return;
  }

  // POST: el módulo de Ventas publica aquí su resumen anual (porAño,
  // perCapita, ventasPeriodo...) cada vez que termina de calcularlo. Así
  // otro negocio del grupo puede leerlo por red (vía /api/grupo) para la
  // pestaña "Año" del Inicio, sin tener que rehacer el cálculo — que mezcla
  // Supabase con históricos en CSV que solo vive en ESTE navegador.
  if (req.method === 'POST') {
    try {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      const resumen = body && body.resumen;
      if (!resumen || typeof resumen !== 'object') {
        res.status(400).json({ ok: false, error: 'Falta "resumen"' });
        return;
      }
      const r = await fetch(`${URL_SB}/rest/v1/ventas_resumen?on_conflict=id`, {
        method: 'POST',
        headers: { ...sbHeaders(KEY_SB), Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{ id: 'actual', datos: resumen, actualizado_en: new Date().toISOString() }]),
      });
      if (!r.ok) throw new Error('guardando resumen: HTTP ' + r.status + ' ' + (await r.text().catch(() => '')));
      res.status(200).json({ ok: true });
    } catch (e) {
      console.error('[ventas_live] fallo guardando resumen:', e.message || e);
      res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
    }
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Solo GET o POST' });
    return;
  }

  // Modo ligero: solo el resumen anual ya guardado, sin tocar órdenes/líneas.
  // Lo usa /api/grupo para traer "Año" de otro negocio del grupo sin pagar el
  // coste de procesar pendientes ni leer hasta 20.000 órdenes por red — eso
  // volvería a hacer lento el cambio de negocio, justo lo que se arregló hoy.
  if (String((req.query && req.query.resumen) || '') === '1') {
    try {
      const r = await fetch(`${URL_SB}/rest/v1/ventas_resumen?id=eq.actual&select=datos&limit=1`, { headers: sbHeaders(KEY_SB) });
      if (!r.ok) throw new Error('leyendo resumen: HTTP ' + r.status);
      const filas = await r.json();
      const resumen = filas && filas[0] ? filas[0].datos : null;
      res.status(200).json({ ok: true, resumen });
    } catch (e) {
      console.error('[ventas_live] fallo leyendo resumen:', e.message || e);
      res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
    }
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

    // Supabase/PostgREST recorta cada respuesta a `max-rows` (1000 en este
    // proyecto) aunque pidas limit=20000. En un local con volumen (Talabar)
    // eso truncaba las ventas: la fusión se quedaba clavada en el primer tramo
    // de 1000 filas y perdía todos los días posteriores. Por eso paginamos:
    // pedimos de 1000 en 1000 con offset hasta que una página venga incompleta.
    // El `order` incluye un desempate único (orden_id / linea_id) para que la
    // paginación por offset sea determinista y no salte ni duplique filas.
    const PAG = 1000;
    async function leerTodo(urlBase) {
      let out = [], offset = 0;
      for (;;) {
        const r = await fetch(`${urlBase}&limit=${PAG}&offset=${offset}`, { headers: sbHeaders(KEY_SB) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const chunk = await r.json();
        out = out.concat(chunk);
        if (chunk.length < PAG) break;      // última página
        offset += PAG;
        if (offset > 1000000) break;        // guardarraíl anti-bucle
      }
      return out;
    }

    let ordenes, lineas, rowsCat;
    try {
      [ordenes, lineas] = await Promise.all([
        leerTodo(`${URL_SB}/rest/v1/ventas_ordenes?${cols}${filtro}&order=fecha.asc,orden_id.asc`),
        leerTodo(`${URL_SB}/rest/v1/ventas_lineas?${cols}${filtro}&order=fecha.asc,linea_id.asc`),
      ]);
    } catch (e) {
      throw new Error('leyendo piso 2: ' + (e.message || e));
    }

    // El catálogo es opcional: si la tabla no existe aún, seguimos sin él
    let categorias = {};
    try {
      rowsCat = await leerTodo(`${URL_SB}/rest/v1/revo_catalogo?select=producto,categoria`);
      for (const c of rowsCat) {
        if (c.producto && c.categoria) categorias[c.producto] = c.categoria;
      }
    } catch (_) { categorias = {}; }
    console.log(`[ventas_live] traductor=${JSON.stringify(traductor)} ordenes=${ordenes.length} lineas=${lineas.length} categorias=${Object.keys(categorias).length} desde=${desde || '(todo)'}`);
    res.status(200).json({
      ok: true, ordenes, lineas, categorias, traductor,
      // Servicios del día de ESTE local (o null → el módulo usa su defecto).
      turnos: parsearTurnosEnv(process.env.TURNOS_SERVICIOS),
    });
  } catch (e) {
    console.error('[ventas_live] fallo:', e.message || e);
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
};

module.exports.parsearTurnosEnv = parsearTurnosEnv;
