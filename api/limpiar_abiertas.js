// /api/limpiar_abiertas.js — Reconciliación de revo_abiertas contra Revo.
//
// EL PROBLEMA QUE RESUELVE
// La libreta `revo_abiertas` se mantenía solo con lo que Revo empuja por
// webhook (alta al abrir, borrado al cerrar). Si un aviso se pierde, la
// libreta se queda mal PARA SIEMPRE, porque nada volvía a preguntarle a Revo.
// Resultado: mesas que ya cerraste siguen "abiertas" (Mesa 26, Mesa 9) y
// mesas realmente abiertas nunca aparecen (chico guitarrista).
//
// LA SOLUCIÓN
// Este barrido le pide a Revo su lista de órdenes abiertas AHORA y deja la
// libreta EXACTAMENTE igual:
//   · borra de revo_abiertas todo lo que Revo ya no lista (mata los zombis,
//     tengan el importe que tengan);
//   · añade a revo_abiertas todo lo que Revo lista y falta en local.
// Ya no depende de que llegue ningún evento: Revo es la fuente de verdad.
//
// Si Revo no contesta, cae al método antiguo (limpieza por pistas locales)
// para no quedarse sin hacer nada.
//
// USO (desde el navegador, sin terminal):
//   ENSAYO (no toca nada, enséñame lo que ve):
//     /api/limpiar_abiertas?key=LA_LLAVE&dry=1
//   REAL:
//     /api/limpiar_abiertas?key=LA_LLAVE
//   Si el barrido quiere borrar muchas de golpe, pide confirmación con &force=1
//   (un seguro para que un fallo de lectura no vacíe la libreta por error).
//
// VARIABLES DE ENTORNO QUE USA (ya existen en tus despliegues):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY (o SUPABASE_KEY)
//   REVO_TOKEN            (mismo que usa revo.js)
//   REVO_TENANT           (solo si el token es legacy / corto)
//   RESTAID_TRADUCTOR_KEY (la llave de este endpoint)

function sbHeaders(key) {
  return { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` };
}

// ── Extracción tolerante de campos de la respuesta de Revo ──
// No sabemos con certeza los nombres exactos de las claves del informe
// openOrders, así que probamos varios alias razonables. Si Revo cambia algo,
// esto sigue funcionando mientras el dato esté con alguno de estos nombres.
function primer(obj, claves) {
  for (const k of claves) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return null;
}
function idDe(o)    { return primer(o, ['id', 'order_id', 'orderId', 'orden_id', 'number', 'num', 'orderNumber']); }
function mesaDe(o)  { return primer(o, ['tableName', 'table', 'mesa', 'table_name', 'name']); }
function totalDe(o) { return primer(o, ['total', 'sum', 'amount', 'importe']); }
function abrtDe(o)  { return primer(o, ['opened', 'openedAt', 'opened_at', 'created_at', 'created', 'date', 'abierto']); }
function paxDe(o)   { return primer(o, ['guests', 'comensales', 'pax', 'covers']); }
function userDe(o)  { return primer(o, ['tenantUserName', 'employee', 'user', 'usuario', 'waiter']); }

// La respuesta puede venir como array pelado o envuelta en {data:[...]} etc.
function extraerLista(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  for (const k of ['data', 'orders', 'results', 'items', 'rows']) {
    if (Array.isArray(json[k])) return json[k];
  }
  return [];
}

// Pide a Revo su lista de abiertas probando los endpoints candidatos.
// Devuelve { ok, endpoint, lista, muestra } o { ok:false, intentos }.
async function revoAbiertas() {
  const token = process.env.REVO_TOKEN;
  if (!token) return { ok: false, error: 'Falta REVO_TOKEN' };

  const isLegacy = token.length < 50;
  const tenant = process.env.REVO_TENANT;
  if (isLegacy && !tenant) return { ok: false, error: 'Token legacy: falta REVO_TENANT' };

  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
  if (isLegacy) headers['tenant'] = tenant;

  // Rango amplio: 13 meses atrás → mañana, para pillar también zombis viejos
  // (p. ej. MESA 21 abierta en 2025).
  const hoy = new Date();
  const manana = new Date(hoy.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const atras = new Date(hoy.getTime() - 400 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const qs = `start_date=${atras}&end_date=${manana}`;

  const candidatos = isLegacy
    ? [
        `https://revoxef.works/api/external/v3/reports/openOrders?${qs}`,
        `https://revoxef.works/api/external/v3/reports/open_orders?${qs}`,
        `https://revoxef.works/api/external/v2/reports/openOrders?${qs}`,
      ]
    : [
        `https://api.integrations.revoxef.works/classic/reports/v3/openOrders?${qs}`,
        `https://api.integrations.revoxef.works/classic/reports/v3/open-orders?${qs}`,
        `https://api.integrations.revoxef.works/classic/reports/openOrders?${qs}`,
      ];

  const intentos = [];
  for (const url of candidatos) {
    try {
      const r = await fetch(url, { headers });
      const txt = await r.text();
      if (!r.ok) { intentos.push({ url, status: r.status, cuerpo: txt.slice(0, 120) }); continue; }
      let json; try { json = JSON.parse(txt); } catch { intentos.push({ url, status: 200, cuerpo: 'no es JSON' }); continue; }
      const lista = extraerLista(json);
      // Éxito si obtenemos una lista (aunque esté vacía) con forma de órdenes.
      if (Array.isArray(lista)) {
        return { ok: true, endpoint: url, lista, muestra: lista.slice(0, 2) };
      }
      intentos.push({ url, status: 200, cuerpo: 'sin lista reconocible' });
    } catch (e) {
      intentos.push({ url, error: String(e && e.message || e).slice(0, 80) });
    }
  }
  return { ok: false, intentos };
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ ok: false, error: 'Solo GET' }); return; }
  const llave = (req.query && req.query.key) || req.headers['x-restaid-key'];
  if (!process.env.RESTAID_TRADUCTOR_KEY || llave !== process.env.RESTAID_TRADUCTOR_KEY) {
    res.status(401).json({ ok: false, error: 'Llave inválida' }); return;
  }
  const dry   = String((req.query && req.query.dry)   || '') === '1';
  const force = String((req.query && req.query.force) || '') === '1';
  const horas = Math.max(1, parseInt((req.query && req.query.horas) || '6', 10) || 6);

  const URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!URL || !KEY) { res.status(500).json({ ok: false, error: 'Supabase no configurado' }); return; }

  try {
    // 1. La libreta actual.
    const rA = await fetch(`${URL}/rest/v1/revo_abiertas?select=orden_id,mesa,comensales,empleado,total,abierta_desde,actualizada_en&limit=1000`, { headers: sbHeaders(KEY) });
    if (!rA.ok) throw new Error('leyendo revo_abiertas: HTTP ' + rA.status);
    const libreta = await rA.json();
    const idsLibreta = new Set(libreta.map(a => String(a.orden_id)));

    // 2. La verdad según Revo.
    const revo = await revoAbiertas();

    // ── CAMINO A: Revo contestó → reconciliación de conjunto ──
    if (revo.ok) {
      // Ids abiertos en Revo (solo los que traen id reconocible).
      const abiertasRevo = [];
      const idsRevo = new Set();
      for (const o of revo.lista) {
        const id = idDe(o);
        if (id === null) continue;
        idsRevo.add(String(id));
        abiertasRevo.push(o);
      }

      // SEGURO: si Revo devolvió filas pero de NINGUNA pudimos sacar id, no
      // sabemos leer el formato → abortamos antes de borrar nada por error.
      if (revo.lista.length > 0 && idsRevo.size === 0) {
        res.status(200).json({
          ok: false,
          via: 'revo',
          error: 'Revo contestó pero no reconozco el formato de sus órdenes. No toco nada.',
          endpoint: revo.endpoint,
          muestra: revo.muestra,
        });
        return;
      }

      // Sobran en la libreta: están en local pero Revo ya no las lista → cerradas.
      const sobran = libreta
        .filter(a => !idsRevo.has(String(a.orden_id)))
        .map(a => ({ orden_id: a.orden_id, mesa: a.mesa, total: a.total, abierta_desde: a.abierta_desde }));

      // Faltan: Revo las lista pero no están en la libreta → alta perdida.
      const faltan = abiertasRevo
        .filter(o => !idsLibreta.has(String(idDe(o))))
        .map(o => ({
          orden_id: idDe(o),
          mesa: mesaDe(o),
          comensales: Math.max(1, parseInt(paxDe(o), 10) || 1),
          empleado: userDe(o),
          total: parseFloat(totalDe(o)) || 0,
          lineas: null, // el desglose llega con el próximo marcaje de esa mesa
          abierta_desde: abrtDe(o),
          actualizada_en: new Date().toISOString(),
        }));

      // SEGURO de borrado masivo: si el barrido quiere quitar muchas de golpe
      // y no viene &force=1, no lo hace (evita vaciados accidentales).
      const borradoGrande = sobran.length > 5 && sobran.length >= libreta.length * 0.6;

      if (dry) {
        res.status(200).json({
          ok: true, modo: 'ENSAYO', via: 'revo', endpoint: revo.endpoint,
          revo_abiertas_ahora: idsRevo.size,
          libreta_ahora: libreta.length,
          a_borrar: sobran,
          a_anadir: faltan,
          aviso_borrado_grande: borradoGrande ? 'Son muchas: en real necesitará &force=1' : null,
          muestra_revo: revo.muestra, // para verificar los nombres de campo
        });
        return;
      }

      if (borradoGrande && !force) {
        res.status(200).json({
          ok: false, via: 'revo',
          error: `El barrido quitaría ${sobran.length} de ${libreta.length}. Repite con &force=1 si es correcto.`,
          a_borrar: sobran,
        });
        return;
      }

      let borradas = 0, anadidas = 0;
      if (sobran.length) {
        const ids = sobran.map(x => x.orden_id);
        const rD = await fetch(`${URL}/rest/v1/revo_abiertas?orden_id=in.(${ids.join(',')})`, { method: 'DELETE', headers: sbHeaders(KEY) });
        if (!rD.ok) throw new Error('borrando sobrantes: HTTP ' + rD.status);
        borradas = ids.length;
      }
      if (faltan.length) {
        const rI = await fetch(`${URL}/rest/v1/revo_abiertas?on_conflict=orden_id`, {
          method: 'POST',
          headers: { ...sbHeaders(KEY), Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify(faltan),
        });
        if (!rI.ok) throw new Error('añadiendo faltantes: HTTP ' + rI.status);
        anadidas = faltan.length;
      }
      console.log(`[limpiar_abiertas] via=revo borradas=${borradas} anadidas=${anadidas}`);
      res.status(200).json({ ok: true, via: 'revo', revisadas: libreta.length, borradas, anadidas, detalle: { a_borrar: sobran, a_anadir: faltan } });
      return;
    }

    // ── CAMINO B: Revo no contestó → red de seguridad antigua (solo borra
    //    con pistas locales; no puede recuperar altas perdidas) ──
    const ids = libreta.map(a => a.orden_id);
    if (!ids.length) { res.status(200).json({ ok: true, via: 'local', revisadas: 0, a_borrar: [] }); return; }

    const rO = await fetch(`${URL}/rest/v1/ventas_ordenes?select=orden_id&orden_id=in.(${ids.join(',')})`, { headers: sbHeaders(KEY) });
    const cerradasHist = new Set(rO.ok ? (await rO.json()).map(x => x.orden_id) : []);

    const rE = await fetch(`${URL}/rest/v1/revo_eventos?select=data&event=eq.order.closed&limit=5000`, { headers: sbHeaders(KEY) });
    const cerradasEvento = new Set();
    if (rE.ok) for (const ev of await rE.json()) { const id = ev.data && ev.data.id; if (id && ids.includes(id)) cerradasEvento.add(id); }

    const ahora = Date.now();
    const aBorrar = [];
    for (const a of libreta) {
      let motivo = null;
      if (cerradasHist.has(a.orden_id)) motivo = 'ya cerrada (histórico)';
      else if (cerradasEvento.has(a.orden_id)) motivo = 'ya cerrada (evento archivado)';
      else {
        const ref = a.actualizada_en || a.abierta_desde;
        const edadH = ref ? (ahora - new Date(ref).getTime()) / 3600000 : 999;
        if ((parseFloat(a.total) || 0) === 0 && edadH >= horas) motivo = `rancia (${Math.round(edadH)}h sin consumo)`;
      }
      if (motivo) aBorrar.push({ orden_id: a.orden_id, mesa: a.mesa, total: a.total, motivo });
    }

    if (dry) {
      res.status(200).json({ ok: true, modo: 'ENSAYO', via: 'local (Revo no accesible)', motivo_fallback: revo.error || revo.intentos, revisadas: libreta.length, a_borrar: aBorrar, se_conservan: libreta.length - aBorrar.length });
      return;
    }
    let borradas = 0;
    if (aBorrar.length) {
      const idsDel = aBorrar.map(x => x.orden_id);
      const rD = await fetch(`${URL}/rest/v1/revo_abiertas?orden_id=in.(${idsDel.join(',')})`, { method: 'DELETE', headers: sbHeaders(KEY) });
      if (!rD.ok) throw new Error('borrando: HTTP ' + rD.status);
      borradas = idsDel.length;
    }
    console.log(`[limpiar_abiertas] via=local revisadas=${libreta.length} borradas=${borradas}`);
    res.status(200).json({ ok: true, via: 'local (Revo no accesible)', revisadas: libreta.length, borradas, detalle: aBorrar });
  } catch (e) {
    console.error('[limpiar_abiertas] fallo:', e.message || e);
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
};

module.exports.config = { maxDuration: 30 };
