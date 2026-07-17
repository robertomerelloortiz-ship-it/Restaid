// /api/_revo_core.js — Núcleo compartido del pipeline de Revo.
//
// El prefijo "_" es deliberado: Vercel NO convierte en función serverless los
// ficheros de /api que empiezan por guion bajo. Esto es un módulo, no un
// endpoint, y además el proyecto va justo en el tope de funciones del plan.
//
// Antes, estas funciones estaban copiadas tal cual en revo_traductor.js,
// hoy_live.js y ventas_live.js. Eran idénticas (verificado), pero mantener
// tres copias de la regla que decide qué es una venta es pedir que un día
// diverjan y cada módulo dé una cifra distinta. Aquí hay una sola copia.
//
// Testeado en test_revo_core.js.

const TZ = 'Europe/Madrid';
const FMT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

// Los webhooks de Revo mandan UTC (la API de informes, en cambio, ya manda
// hora local de Madrid: no pasar por aquí lo que venga de ahí).
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

// Escribe una orden ya transformada en Piso 2. Idempotente: reprocesar el
// mismo evento no duplica nada (upsert por orden_id / linea_id).
async function guardarOrden(URL_SB, KEY_SB, t) {
  const rO = await fetch(`${URL_SB}/rest/v1/ventas_ordenes?on_conflict=orden_id`, {
    method: 'POST',
    headers: { ...sbHeaders(KEY_SB), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([t.orden]),
  });
  if (!rO.ok) throw new Error('orden ' + t.orden.orden_id + ': HTTP ' + rO.status + ' ' + (await rO.text().catch(() => '')));

  if (t.lineas.length) {
    const rL = await fetch(`${URL_SB}/rest/v1/ventas_lineas?on_conflict=linea_id`, {
      method: 'POST',
      headers: { ...sbHeaders(KEY_SB), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(t.lineas),
    });
    if (!rL.ok) throw new Error('lineas orden ' + t.orden.orden_id + ': HTTP ' + rL.status + ' ' + (await rL.text().catch(() => '')));
  }
}

// Traduce los eventos pendientes de Piso 1 a Piso 2 y los marca procesados.
//
// Desde que el webhook traduce en el acto, esto normalmente no encuentra nada:
// es la red de seguridad para los eventos cuya traducción falló en su momento.
// Un evento problemático no bloquea al resto: se queda pendiente y se anota.
async function procesarPendientes(URL_SB, KEY_SB, limite = 200) {
  const rPend = await fetch(
    `${URL_SB}/rest/v1/revo_eventos?procesado=eq.false&event=eq.order.closed&order=id.asc&limit=${limite}`,
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
        // Cierre intermedio o cancelada: no entra al histórico, pero se marca
        // procesado para no revisarlo eternamente.
        descartados++;
        idsOK.push(ev.id);
        continue;
      }
      await guardarOrden(URL_SB, KEY_SB, t);
      procesados++;
      idsOK.push(ev.id);
    } catch (e) {
      errores.push({ evento_id: ev.id, error: String(e.message || e).slice(0, 200) });
    }
  }

  if (idsOK.length) {
    const rM = await fetch(`${URL_SB}/rest/v1/revo_eventos?id=in.(${idsOK.join(',')})`, {
      method: 'PATCH',
      headers: { ...sbHeaders(KEY_SB), Prefer: 'return=minimal' },
      body: JSON.stringify({ procesado: true }),
    });
    if (!rM.ok) throw new Error('marcando procesados: HTTP ' + rM.status);
  }

  return { procesados, descartados, errores };
}

// Hora de inicio real de la "curva del día" (gráfico de facturación por hora
// en el Inicio). Antes estaba fijada a las 12h en el HTML — encajaba con
// Talabar (abre justo a esa hora) pero no con negocios que abren antes, como
// La Canilla. Se calcula como la hora más temprana entre: el cierre de
// cualquier pedido ya cerrado hoy, o la apertura de cualquier mesa que siga
// en curso. Así funciona igual para cualquier negocio del grupo, presente o
// futuro, sin tener que tocar código cada vez que cambie el horario de uno.
//
// Nota deliberada: un cierre de madrugada (p. ej. 01:30, cena que se alarga)
// puede salir como "la hora más baja" tal cual, aunque en la curva esa franja
// se pinte al final (con +24h). Es un caso raro — normalmente lo primero del
// día es una apertura o un cierre de la mañana — y de momento se deja así,
// documentado, en vez de complicar el cálculo para un caso que casi no ocurre.
function horaInicioActividad(cerradasFilas, abiertasFilas) {
  let hora = null;
  const considerar = (filas, campo) => {
    for (const o of filas || []) {
      const v = o && o[campo];
      if (!v) continue;
      const h = parseInt(String(v).slice(11, 13), 10);
      if (!isNaN(h) && (hora === null || h < hora)) hora = h;
    }
  };
  considerar(cerradasFilas, 'cerrado');
  considerar(abiertasFilas, 'abierta_desde');
  return hora;
}

module.exports = {
  TZ, CORTE_JORNADA_H,
  utcAMadrid, jornadaDe, num, transformarEvento,
  sbHeaders, guardarOrden, procesarPendientes,
  horaInicioActividad,
};
