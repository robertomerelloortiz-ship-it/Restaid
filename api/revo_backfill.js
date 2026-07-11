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

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ ok: false, error: 'Solo GET' }); return; }
  const llave = (req.query && req.query.key) || req.headers['x-restaid-key'];
  if (!process.env.RESTAID_TRADUCTOR_KEY || llave !== process.env.RESTAID_TRADUCTOR_KEY) {
    res.status(401).json({ ok: false, error: 'Llave inválida' }); return;
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
