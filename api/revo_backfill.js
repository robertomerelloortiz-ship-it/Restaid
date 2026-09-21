// /api/revo_backfill.js — Relleno de huecos del histórico desde la API de Revo (v2).
//
// v2, tras diagnóstico real (11-jul-2026):
// - La API de reports habla OTRO dialecto que el webhook: campos en catalán
//   (taula, comensals, oberta, tancada, producte, quantitat, treballador)
//   y sin status/invoices/payments. Se transforma con transformarReporte().
// - Parámetros imitados del código legacy que funcionaba: solo withContents=1,
//   paginación por last_page del nivel raíz. Nada de per_page/withPayments.
// - Las horas del reporte se asumen en HORA LOCAL (así las consumía el código
//   legacy durante meses con las curvas de turnos correctas). El modo ensayo
//   muestra la hora cruda y la transformada para verificarlo con datos reales.
// - Margen de +1 día al final (truco legacy): las mesas cerradas de madrugada
//   se asignan al día siguiente.
// - ANTI-DUPLICADOS: se consultan las órdenes ya existentes en ventas_ordenes
//   y se saltan (el webhook ya capturó el 10-11 de julio; sus líneas tienen
//   ids reales y las del reporte serían sintéticas → duplicarían).
// - Las líneas del reporte no traen id propio → id sintético NEGATIVO
//   (-(orden_id*1000+i)) para no colisionar jamás con los ids reales
//   (positivos) del webhook.
//
// Uso:
//   ENSAYO:  GET /api/revo_backfill?desde=2026-07-01&hasta=2026-07-11&key=LA_LLAVE&dry=1
//   REAL:    igual sin &dry=1


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

function normTS(s) {
  // 'YYYY-MM-DD HH:MM:SS' (hora local) → misma cadena, saneada
  if (!s) return null;
  const t = String(s).replace('T', ' ').slice(0, 19);
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? t : null;
}

/** Transforma una orden del dialecto REPORTE (catalán, hora local) al piso 2.
 *  Campos verificados con respuesta real del 11-jul-2026 (orden 240226). */
function transformarReporte(o) {
  if (!o || !o.id) return null;
  const cerrado = normTS(o.tancada);
  const abierto = normTS(o.oberta);
  if (!cerrado) return null; // sin cierre no es una venta consolidada
  // OJO dialecto reporte (verificado 11-jul-2026, orden 241746): status 0 con
  // total > 0 es una venta REAL (tique rápido de barra). Solo se descarta el
  // patrón "cierre intermedio" conocido del webhook: status 0 Y total 0.
  if (o.status !== undefined && o.status !== 1 && num(o.total) <= 0) return null;

  let duracion = null;
  if (abierto) {
    const dA = new Date(abierto.replace(' ', 'T'));
    const dC = new Date(cerrado.replace(' ', 'T'));
    if (!isNaN(dA) && !isNaN(dC)) duracion = Math.round((dC - dA) / 60000);
  }

  const orden = {
    orden_id: o.id,
    fecha: cerrado.slice(0, 10),
    jornada: jornadaDe(cerrado),
    abierto, cerrado,
    duracion_min: duracion,
    comensales: Math.max(1, num(o.comensals) || 1),
    mesa: o.taula || null,
    mesa_id: o.table_id ?? null,
    empleado: o.usuari || null,
    empleado_id: o.user_id ?? null,
    total: num(o.total),
    subtotal: o.subtotal != null ? num(o.subtotal) : null,
    impuestos: o.impost != null ? num(o.impost) : null,
    descuento: num(o.descompte) + num(o.descompte_de_comanda),
    propina: 0, metodo_pago: null, turno_revo: null,
    reembolsada: !!o.refunded_invoice,
  };

  const lineas = (o.contents || []).map((c, i) => ({
    linea_id: c.id ?? -(o.id * 1000 + i), // id real; sintético negativo solo si faltara
    orden_id: o.id,
    fecha: orden.fecha,
    producto: c.producte || '?',
    item_id: c.item_id ?? null,
    cantidad: num(c.quantitat) || 1,
    precio_unit: num(c.quantitat) ? num(c.total) / num(c.quantitat) : num(c.total),
    total: num(c.total),
    subtotal: c.subtotal != null ? num(c.subtotal) : null,
    impuestos: c.impost != null ? num(c.impost) : null,
    descuento: num(c.discount_amount),
    empleado_id: c.user_id ?? null,
    dish_order: c.dishOrder ?? null,
    marcado: normTS(c.data) || cerrado,
  }));

  return { orden, lineas };
}

function sbHeaders(key) {
  return { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` };
}

// ── Importación desde el CSV «Órdenes» de Revo (para locales SIN API, solo
//    webhooks, como La Canilla). Recupera días cuyos avisos se perdieron.
//    Columnas verificadas con export real 21-sep-2026:
//    ID;Mesa;Sala;Empleado;Comensales;Abierto;Cerrado;Valor medio;Suma;
//    Descuento;Subtotal;Impuesto total;Total;Entrega   (hora local, coma decimal)
//    Se usa desde /importar.html (POST {csv}). Mismo transformador que la API,
//    así las órdenes quedan idénticas a las del backfill.
function parsearCSVOrdenes(texto) {
  const filas = String(texto || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  if (!filas.length) return { error: 'CSV vacío' };
  const cab = filas[0].split(';').map(c => c.trim().toLowerCase());
  // Acepta los dos formatos de Revo: «Órdenes» (ID, Empleado, Impuesto total)
  // y «Órdenes abiertas» (Orden, Usuario, Impuesto).
  const col = (...ns) => { for (const n of ns) { const i = cab.indexOf(n); if (i >= 0) return i; } return -1; };
  const iID = col('id', 'orden'), iMesa = col('mesa'), iEmp = col('empleado', 'usuario'), iCom = col('comensales'),
        iAb = col('abierto'), iCe = col('cerrado'), iDes = col('descuento'),
        iSub = col('subtotal'), iImp = col('impuesto total', 'impuesto'), iTot = col('total');
  if (iID < 0 || iCe < 0 || iTot < 0) return { error: 'No parece el CSV «Órdenes» de Revo (faltan ID/Cerrado/Total)' };
  const limpio = v => { const t = (v == null ? '' : String(v)).trim(); return (t === '--' || t === '') ? null : t; };
  const out = [];
  for (let i = 1; i < filas.length; i++) {
    const c = filas[i].split(';');
    const id = parseInt(limpio(c[iID]), 10);
    if (!id) continue;
    out.push({
      id,
      taula: limpio(c[iMesa]),
      usuari: (limpio(c[iEmp]) || '').replace(/\s+/g, ' ') || null,
      comensals: limpio(c[iCom]),
      oberta: limpio(c[iAb]),
      tancada: limpio(c[iCe]),          // null si sigue abierta → se descarta
      descompte: limpio(c[iDes]),
      subtotal: iSub >= 0 ? limpio(c[iSub]) : null,
      impost: iImp >= 0 ? limpio(c[iImp]) : null,
      total: limpio(c[iTot]),
    });
  }
  return { ordenes: out };
}


// ── CSV «Productos» de Revo → ventas_lineas (qué se vendió en cada ticket).
//    Columnas verificadas 21-sep-2026: Orden;Producto;Categoría;Cantidad;…;
//    ID de producto;…;Mesa;Empleado;…;Precio;Subtotal;…;Descuento;Impuesto total;
//    Impuesto;Total;Fecha. Se importa DESPUÉS del de Órdenes: cada línea toma la
//    fecha de cierre de su ticket. Tickets que ya tienen líneas (entraron por
//    webhook) no se tocan; líneas de tickets aún abiertos se ignoran.
async function importarCSVProductos(texto, res, dry, URL_SB, KEY_SB) {
  const filas = String(texto).replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  const cab = filas[0].split(';').map(c => c.trim().toLowerCase());
  const col = n => cab.indexOf(n);
  const iO = col('orden'), iP = col('producto'), iC = col('cantidad'), iId = col('id de producto'),
        iSub = col('subtotal'), iDes = col('descuento'), iImp = col('impuesto total'),
        iT = col('total'), iF = col('fecha');
  if (iO < 0 || iP < 0 || iT < 0) { res.status(400).json({ ok: false, error: 'No parece el CSV «Productos» de Revo' }); return; }
  const v = x => { const t = (x == null ? '' : String(x)).trim(); return (t === '--' || t === '') ? null : t; };
  const crudas = [];
  for (let i = 1; i < filas.length; i++) {
    const c = filas[i].split(';');
    const o = parseInt(v(c[iO]), 10); if (!o) continue;
    crudas.push({ o, c });
  }
  if (!crudas.length) { res.status(200).json({ ok: true, se_guardarian: 0 }); return; }
  const ids = [...new Set(crudas.map(x => x.o))];

  // Fecha de cierre de cada ticket (desde ventas_ordenes) y tickets que ya tienen líneas.
  const fechaDe = new Map(), conLineas = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const trozo = ids.slice(i, i + 200).join(',');
    const rO = await fetch(`${URL_SB}/rest/v1/ventas_ordenes?select=orden_id,fecha&orden_id=in.(${trozo})&limit=1000`, { headers: sbHeaders(KEY_SB) });
    if (!rO.ok) { res.status(500).json({ ok: false, error: 'Leyendo órdenes: HTTP ' + rO.status }); return; }
    (await rO.json()).forEach(x => fechaDe.set(Number(x.orden_id), x.fecha));
    const rL = await fetch(`${URL_SB}/rest/v1/ventas_lineas?select=orden_id&orden_id=in.(${trozo})&limit=1000`, { headers: sbHeaders(KEY_SB) });
    if (!rL.ok) { res.status(500).json({ ok: false, error: 'Leyendo líneas: HTTP ' + rL.status }); return; }
    (await rL.json()).forEach(x => conLineas.add(Number(x.orden_id)));
  }

  let sinTicket = 0, yaTenian = 0;
  const contador = {}, nuevas = [], porJornada = {};
  for (const { o, c } of crudas) {
    contador[o] = (contador[o] || 0) + 1;       // índice estable por ticket (orden del fichero)
    if (!fechaDe.has(o)) { sinTicket++; continue; }
    if (conLineas.has(o)) { yaTenian++; continue; }
    const cant = num(v(c[iC])) || 1, tot = num(v(c[iT]));
    const fecha = fechaDe.get(o);
    nuevas.push({
      linea_id: -(o * 1000 + contador[o]),       // sintético negativo: no choca con ids reales
      orden_id: o, fecha,
      producto: v(c[iP]) || '?',
      item_id: iId >= 0 && v(c[iId]) ? parseInt(v(c[iId]), 10) : null,
      cantidad: cant,
      precio_unit: cant ? Math.round(tot / cant * 1000) / 1000 : tot,
      total: tot,
      subtotal: iSub >= 0 && v(c[iSub]) != null ? num(v(c[iSub])) : null,
      impuestos: iImp >= 0 && v(c[iImp]) != null ? num(v(c[iImp])) : null,
      descuento: iDes >= 0 ? num(v(c[iDes])) : 0,
      empleado_id: null, dish_order: null,
      marcado: iF >= 0 ? normTS(v(c[iF])) : null,
    });
    const pj = porJornada[fecha] = porJornada[fecha] || { tickets: 0, euros: 0, _t: new Set() };
    pj._t.add(o); pj.tickets = pj._t.size; pj.euros = Math.round((pj.euros + tot) * 100) / 100;
  }
  Object.values(porJornada).forEach(x => delete x._t);
  const fechas = nuevas.map(x => x.fecha).sort();
  const rango = fechas.length ? { desde: fechas[0], hasta: fechas[fechas.length - 1] } : null;

  if (dry) {
    res.status(200).json({ ok: true, tipo: 'productos', modo: 'ENSAYO (no se ha escrito nada)', rango,
      filas_csv: crudas.length, se_guardarian: nuevas.length, tickets_ya_con_detalle: yaTenian,
      sin_ticket_en_restaid: sinTicket, por_jornada: porJornada, muestra: nuevas[0] || null });
    return;
  }
  let guardadas = 0; const errores = [];
  for (let i = 0; i < nuevas.length; i += 300) {
    const lote = nuevas.slice(i, i + 300);
    const r = await fetch(`${URL_SB}/rest/v1/ventas_lineas?on_conflict=linea_id`, {
      method: 'POST', headers: { ...sbHeaders(KEY_SB), Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(lote),
    });
    if (!r.ok) { errores.push(`lote ${i}: HTTP ${r.status} ${(await r.text()).slice(0, 150)}`); continue; }
    guardadas += lote.length;
  }
  res.status(200).json({ ok: errores.length === 0, tipo: 'productos', modo: 'REAL', rango, guardadas,
    tickets_ya_con_detalle: yaTenian, sin_ticket_en_restaid: sinTicket, por_jornada: porJornada, errores });
}


// ── Informe «Órdenes abiertas» de Revo → cuadra revo_abiertas SIN token.
//    Revo es la verdad: toda mesa de una jornada ANTERIOR que RESTAID tiene
//    como abierta y que NO aparece en el informe, está cerrada en Revo (su
//    aviso se perdió) → se borra. Las del día de hoy no se tocan (las gestiona
//    el webhook en vivo). Las del informe que falten en RESTAID se añaden.
async function sincronizarAbiertas(ordenes, res, dry, URL_SB, KEY_SB) {
  { const vistos = new Set(); ordenes = ordenes.filter(o => { const k = String(o.id); if (vistos.has(k)) return false; vistos.add(k); return true; }); }
  const enRevo = new Set(ordenes.map(o => String(o.id)));
  const r = await fetch(`${URL_SB}/rest/v1/revo_abiertas?select=orden_id,mesa,total,abierta_desde&limit=1000`, { headers: sbHeaders(KEY_SB) });
  if (!r.ok) { res.status(500).json({ ok: false, error: 'Leyendo revo_abiertas: HTTP ' + r.status }); return; }
  const locales = await r.json();
  const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  const p2 = n => String(n).padStart(2, '0');
  const hoyTs = `${ahora.getFullYear()}-${p2(ahora.getMonth() + 1)}-${p2(ahora.getDate())} ${p2(ahora.getHours())}:${p2(ahora.getMinutes())}:00`;
  const jHoy = jornadaDe(hoyTs);
  const esDeHoy = a => a.abierta_desde && jornadaDe(String(a.abierta_desde).replace('T', ' ').slice(0, 19)) >= jHoy;

  const aBorrar = locales.filter(a => !enRevo.has(String(a.orden_id)) && !esDeHoy(a));
  const idsLocales = new Set(locales.map(a => String(a.orden_id)));
  const aAnadir = ordenes.filter(o => !idsLocales.has(String(o.id))).map(o => ({
    orden_id: o.id, mesa: o.taula, comensales: Math.max(1, parseInt(o.comensals, 10) || 1),
    empleado: o.usuari, total: num(o.total), lineas: null,
    abierta_desde: normTS(o.oberta), actualizada_en: new Date().toISOString(),
  }));
  const resumen = {
    tipo: 'abiertas', abiertas_en_revo: ordenes.length,
    se_borrarian: aBorrar.map(a => ({ mesa: a.mesa, total: num(a.total), desde: String(a.abierta_desde || '').slice(0, 10) })),
    se_anadirian: aAnadir.map(a => ({ mesa: a.mesa, total: a.total, desde: String(a.abierta_desde || '').slice(0, 10) })),
  };
  if (dry) { res.status(200).json({ ok: true, modo: 'ENSAYO (no se ha escrito nada)', ...resumen }); return; }
  const errores = [];
  if (aBorrar.length) {
    const rD = await fetch(`${URL_SB}/rest/v1/revo_abiertas?orden_id=in.(${aBorrar.map(a => a.orden_id).join(',')})`, { method: 'DELETE', headers: sbHeaders(KEY_SB) });
    if (!rD.ok) errores.push('borrando: HTTP ' + rD.status);
  }
  if (aAnadir.length) {
    const rI = await fetch(`${URL_SB}/rest/v1/revo_abiertas?on_conflict=orden_id`, {
      method: 'POST', headers: { ...sbHeaders(KEY_SB), Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(aAnadir),
    });
    if (!rI.ok) errores.push('añadiendo: HTTP ' + rI.status);
  }
  res.status(200).json({ ok: errores.length === 0, modo: 'REAL', ...resumen, errores });
}

async function importarCSV(req, res, dry) {
  const URL_SB = process.env.SUPABASE_URL;
  const KEY_SB = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!URL_SB || !KEY_SB) { res.status(500).json({ ok: false, error: 'Supabase no configurado' }); return; }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = { csv: body }; } }
  const cab0 = String((body && body.csv) || '').replace(/^\uFEFF/, '').split(/\r?\n/)[0].toLowerCase();
  if (cab0.startsWith('orden;producto')) { await importarCSVProductos(body.csv, res, dry, URL_SB, KEY_SB); return; }
  const p = parsearCSVOrdenes(body && body.csv);
  if (p.error) { res.status(400).json({ ok: false, error: p.error }); return; }

  // ¿Es el informe «Órdenes abiertas» de Revo? (todas las filas sin cerrar)
  if (p.ordenes.length && p.ordenes.every(o => !o.tancada)) {
    await sincronizarAbiertas(p.ordenes, res, dry, URL_SB, KEY_SB); return;
  }
  let abiertas = 0, descartadas = 0;
  const transformadas = [];
  for (const o of p.ordenes) {
    if (!o.tancada) { abiertas++; continue; }
    const t = transformarReporte(o);
    if (!t) { descartadas++; continue; }
    transformadas.push(t);
  }
  if (!transformadas.length) {
    res.status(200).json({ ok: true, modo: dry ? 'ENSAYO' : 'REAL', filas_csv: p.ordenes.length, sin_cerrar: abiertas, descartadas, se_guardarian: 0 });
    return;
  }
  const fechas = transformadas.map(t => t.orden.fecha).sort();
  const desde = fechas[0], hasta = fechas[fechas.length - 1];

  // Anti-duplicados: las que ya entraron por webhook NO se tocan (tienen más
  // detalle: líneas, pago…). Paginado: Supabase corta en 1000 filas.
  const existentes = new Set();
  for (let off = 0; off < 50000; off += 1000) {
    const r = await fetch(`${URL_SB}/rest/v1/ventas_ordenes?select=orden_id&fecha=gte.${desde}&fecha=lte.${hasta}&order=orden_id.asc&limit=1000&offset=${off}`, { headers: sbHeaders(KEY_SB) });
    if (!r.ok) { res.status(500).json({ ok: false, error: 'Leyendo existentes: HTTP ' + r.status }); return; }
    const lote = await r.json();
    lote.forEach(x => existentes.add(Number(x.orden_id)));
    if (lote.length < 1000) break;
  }
  const nuevas = transformadas.filter(t => !existentes.has(Number(t.orden.orden_id)));

  const porJornada = {};
  nuevas.forEach(t => { const j = t.orden.jornada; porJornada[j] = porJornada[j] || { tickets: 0, euros: 0 }; porJornada[j].tickets++; porJornada[j].euros = Math.round((porJornada[j].euros + t.orden.total) * 100) / 100; });

  if (dry) {
    res.status(200).json({
      ok: true, modo: 'ENSAYO (no se ha escrito nada)', rango: { desde, hasta },
      filas_csv: p.ordenes.length, sin_cerrar: abiertas, descartadas,
      ya_en_restaid: transformadas.length - nuevas.length, se_guardarian: nuevas.length,
      por_jornada: porJornada, muestra: nuevas[0] ? nuevas[0].orden : null,
    });
    return;
  }
  let guardadas = 0; const errores = [];
  for (let i = 0; i < nuevas.length; i += 200) {
    const lote = nuevas.slice(i, i + 200).map(t => t.orden);
    const r = await fetch(`${URL_SB}/rest/v1/ventas_ordenes?on_conflict=orden_id`, {
      method: 'POST',
      headers: { ...sbHeaders(KEY_SB), Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(lote),
    });
    if (!r.ok) { errores.push(`lote ${i}: HTTP ${r.status} ${(await r.text()).slice(0, 150)}`); continue; }
    guardadas += lote.length;
  }
  res.status(200).json({ ok: errores.length === 0, modo: 'REAL', rango: { desde, hasta }, guardadas, ya_en_restaid: transformadas.length - nuevas.length, sin_cerrar: abiertas, por_jornada: porJornada, errores });
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Solo GET/POST' }); return; }
  const llave = (req.query && req.query.key) || req.headers['x-restaid-key'];
  if (!process.env.RESTAID_TRADUCTOR_KEY || llave !== process.env.RESTAID_TRADUCTOR_KEY) {
    res.status(401).json({ ok: false, error: 'Llave inválida' }); return;
  }
  if (req.method === 'POST') {
    try { await importarCSV(req, res, String((req.query && req.query.dry) || '') === '1'); }
    catch (e) { res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
    return;
  }
  const desde = (req.query && req.query.desde) || '';
  const hasta = (req.query && req.query.hasta) || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
    res.status(400).json({ ok: false, error: 'Faltan desde/hasta (YYYY-MM-DD)' }); return;
  }
  const dry = String((req.query && req.query.dry) || '') === '1';

  const token = process.env.REVO_TOKEN;
  if (!token) { res.status(500).json({ ok: false, error: 'Falta REVO_TOKEN' }); return; }
  const isLegacy = token.length < 50;
  const BASE = isLegacy ? 'https://revoxef.works' : 'https://api.integrations.revoxef.works';
  const PATH = isLegacy ? '/api/external/v3/reports/orders' : '/classic/reports/v3/orders';
  if (isLegacy && !process.env.REVO_TENANT) {
    res.status(500).json({ ok: false, error: 'Token legacy: falta REVO_TENANT' }); return;
  }
  const revoHeaders = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
  if (isLegacy) revoHeaders.tenant = process.env.REVO_TENANT;

  const URL_SB = process.env.SUPABASE_URL;
  const KEY_SB = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!URL_SB || !KEY_SB) { res.status(500).json({ ok: false, error: 'Supabase no configurado' }); return; }

  try {
    // ── 1. Descargar de Revo: margen +1 día, paginación estilo legacy ──
    const finMargen = new Date(hasta + 'T12:00:00');
    finMargen.setDate(finMargen.getDate() + 1);
    const hastaMargen = finMargen.toISOString().slice(0, 10);

    const ordenesCrudas = [];
    let page = 1, lastPage = 1, debugPrimera = null;
    do {
      const qs = new URLSearchParams({
        start_date: desde, end_date: hastaMargen, withContents: '1', page: String(page),
      });
      const r = await fetch(`${BASE}${PATH}?${qs}`, { headers: revoHeaders });
      const texto = await r.text();
      let cuerpo = {};
      try { cuerpo = JSON.parse(texto); } catch (_) {}
      if (page === 1) {
        debugPrimera = {
          url: `${BASE}${PATH}?${qs}`, http: r.status,
          claves_respuesta: cuerpo && typeof cuerpo === 'object' ? Object.keys(cuerpo).slice(0, 15) : typeof cuerpo,
          primeros_400_chars: texto.slice(0, 400),
        };
      }
      if (!r.ok) throw new Error(`Revo HTTP ${r.status} (pág ${page}): ${texto.slice(0, 200)}`);
      const lote = Array.isArray(cuerpo) ? cuerpo : Array.isArray(cuerpo.data) ? cuerpo.data : [];
      ordenesCrudas.push(...lote);
      lastPage = cuerpo.last_page || (cuerpo.meta && cuerpo.meta.last_page) || 1;
      page++;
    } while (page <= lastPage && page <= 40);

    // ── 2. Transformar y filtrar al rango pedido (por fecha de cierre local) ──
    let convertidas = 0, descartadas = 0, fueraDeRango = 0;
    const transformadas = [];
    for (const cruda of ordenesCrudas) {
      const t = transformarReporte(cruda);
      if (!t) { descartadas++; continue; }
      if (t.orden.fecha < desde || t.orden.fecha > hasta) { fueraDeRango++; continue; }
      transformadas.push(t); convertidas++;
    }

    // ── 3. Anti-duplicados: saltar órdenes que ya existen en el piso 2 ──
    const rEx = await fetch(
      `${URL_SB}/rest/v1/ventas_ordenes?select=orden_id&fecha=gte.${desde}&fecha=lte.${hasta}&limit=20000`,
      { headers: sbHeaders(KEY_SB) }
    );
    const existentes = rEx.ok ? new Set((await rEx.json()).map(x => x.orden_id)) : new Set();
    const nuevas = transformadas.filter(t => !existentes.has(t.orden.orden_id));
    const yaExistian = transformadas.length - nuevas.length;

    // ── 4. Ensayo: enseñar, no escribir ──
    if (dry) {
      const m = nuevas[0] || transformadas[0] || null;
      res.status(200).json({
        ok: true, modo: 'ENSAYO (no se ha escrito nada)',
        rango: { desde, hasta, hasta_con_margen: hastaMargen },
        recibidas_de_revo: ordenesCrudas.length,
        convertibles: convertidas, descartadas, fuera_de_rango: fueraDeRango,
        ya_en_piso2: yaExistian, se_guardarian: nuevas.length,
        muestra_cruda: ordenesCrudas[0] ? {
          id: ordenesCrudas[0].id, taula: ordenesCrudas[0].taula,
          comensals: ordenesCrudas[0].comensals,
          oberta: ordenesCrudas[0].oberta, tancada: ordenesCrudas[0].tancada,
          total: ordenesCrudas[0].total,
          n_contents: (ordenesCrudas[0].contents || []).length,
        } : null,
        muestra_transformada: m ? m.orden : null,
        muestra_linea: m && m.lineas[0] ? m.lineas[0] : null,
        diagnostico: debugPrimera,
      });
      return;
    }

    // ── 5. Escritura real por lotes (upsert idempotente) ──
    let guardadas = 0;
    const errores = [];
    for (let i = 0; i < nuevas.length; i += 50) {
      const lote = nuevas.slice(i, i + 50);
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

    console.log(`[revo_backfill] ${desde}→${hasta}: revo=${ordenesCrudas.length} nuevas=${nuevas.length} guardadas=${guardadas} ya_existian=${yaExistian} descartadas=${descartadas}`);
    res.status(200).json({ ok: true, rango: { desde, hasta }, recibidas_de_revo: ordenesCrudas.length, guardadas, ya_en_piso2: yaExistian, descartadas, fuera_de_rango: fueraDeRango, errores });
  } catch (e) {
    console.error('[revo_backfill] fallo:', e.message || e);
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
};
