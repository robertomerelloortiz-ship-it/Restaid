// /api/grupo.js — Capa de grupo (varios locales del mismo dueño).
//
// Modelo (el de Revo): cada local es un despliegue independiente, con su
// usuario, su contraseña, su base de datos y su cuenta de Revo. Este endpoint
// NO mezcla datos: pregunta a cada local por su propio /api/hoy_live y suma
// los totales para la vista de grupo del Inicio.
//
// Uso:
//   GET /api/grupo                 → { locales:[{id,nombre}] }  (para el selector)
//   GET /api/grupo?local=<id>      → el hoy_live de ese local, tal cual
//   GET /api/grupo?local=todos     → la SUMA de todos los locales
//
// Variables (las mismas en todos los despliegues del grupo):
//   GRUPO_LOCALES = [{"id":"talabar","nombre":"Talabar","url":"https://talabar.vercel.app"},
//                    {"id":"local2","nombre":"Segundo","url":"https://local2.vercel.app"}]
//   GRUPO_TOKEN   = secreto compartido; viaja SOLO de servidor a servidor,
//                   nunca baja al navegador.
//
// Si GRUPO_LOCALES no está definida, no hay grupo: devuelve lista vacía y el
// Inicio se comporta exactamente como hasta ahora.

function locales() {
  try {
    const raw = process.env.GRUPO_LOCALES;
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(l => l && l.id && l.url).map(l => ({
      id: String(l.id), nombre: String(l.nombre || l.id), url: String(l.url).replace(/\/+$/, ''),
    }));
  } catch (e) {
    console.error('[grupo] GRUPO_LOCALES mal formada:', e.message);
    return [];
  }
}

// El navegador se identifica con la contraseña de SU local.
// Cabeceras HTTP = Latin-1: contraseñas con ñ/tildes llegan alteradas aunque
// el login funcione. Comparación tolerante (cruda, reparada y recortada).
function coincide(recibido, esperado) {
  if (!esperado) return false;
  const cands = new Set([recibido, String(recibido).trim()]);
  try { cands.add(Buffer.from(recibido, 'latin1').toString('utf8')); } catch (e) {}
  try { cands.add(decodeURIComponent(recibido)); } catch (e) {}
  return cands.has(esperado) || cands.has(esperado.trim());
}
function autorizado(req) {
  return coincide(req.headers['x-restaid-pass'] || '', process.env.RESTAID_PASS);
}

async function pedirLocal(l) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(l.url + '/api/hoy_live', {
      headers: { 'x-restaid-grupo': process.env.GRUPO_TOKEN || '' },
      signal: ctrl.signal,
    });
    if (!r.ok) return { ...l, ok: false, error: 'HTTP ' + r.status };
    const d = await r.json();
    if (!d || !d.ok) return { ...l, ok: false, error: (d && d.error) || 'respuesta no válida' };
    // El resumen anual de Ventas es un añadido MENOR (para la pestaña "Año"):
    // si falla o tarda, no debe tirar abajo el resto del Inicio del grupo,
    // que es lo importante. Se pide con su propio margen corto y en paralelo,
    // nunca bloqueando ni pudiendo hacer fallar la petición principal.
    try {
      const ctrl2 = new AbortController();
      const t2 = setTimeout(() => ctrl2.abort(), 4000);
      const rv = await fetch(l.url + '/api/ventas_live?resumen=1', {
        headers: { 'x-restaid-grupo': process.env.GRUPO_TOKEN || '' },
        signal: ctrl2.signal,
      }).finally(() => clearTimeout(t2));
      if (rv.ok) {
        const dv = await rv.json();
        if (dv && dv.ok && dv.resumen) d.ventasResumen = dv.resumen;
      }
    } catch (e) { /* sin resumen anual esta vez; "Año" caerá a su respaldo local */ }
    return { ...l, ok: true, datos: d };
  } catch (e) {
    return { ...l, ok: false, error: String(e.name === 'AbortError' ? 'sin respuesta (9s)' : e.message).slice(0, 120) };
  } finally {
    clearTimeout(t);
  }
}

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const sumaBloque = (arr, k) => ({
  euros: r2(arr.reduce((s, d) => s + ((d[k] && d[k].euros) || 0), 0)),
  n: arr.reduce((s, d) => s + ((d[k] && d[k].n) || 0), 0),
  comensales: arr.reduce((s, d) => s + ((d[k] && d[k].comensales) || 0), 0),
});

// Consolida N respuestas de hoy_live en una sola con la MISMA forma, para que
// el Inicio la pinte sin cambiar nada.
function consolidar(oks) {
  const ds = oks.map(o => o.datos);
  const cerradas = sumaBloque(ds, 'cerradas');
  const abiertas = sumaBloque(ds, 'abiertas');

  // Mesas abiertas: se concatenan etiquetando de qué local es cada una.
  abiertas.mesas = oks.flatMap(o => ((o.datos.abiertas && o.datos.abiertas.mesas) || [])
    .map(m => ({ ...m, mesa: `${o.nombre} · ${m.mesa}`, local: o.id })))
    .sort((a, b) => String(a.abierta_desde || '').localeCompare(String(b.abierta_desde || '')));

  const control = {
    n: ds.reduce((s, d) => s + ((d.control && d.control.n) || 0), 0),
    euros: r2(ds.reduce((s, d) => s + ((d.control && d.control.euros) || 0), 0)),
    mesas: oks.flatMap(o => ((o.datos.control && o.datos.control.mesas) || [])
      .map(m => ({ ...m, mesa: `${o.nombre} · ${m.mesa}`, local: o.id }))),
  };

  const colgadas = {
    n: ds.reduce((s, d) => s + ((d.colgadas && d.colgadas.n) || 0), 0),
    euros: r2(ds.reduce((s, d) => s + ((d.colgadas && d.colgadas.euros) || 0), 0)),
    mesas: oks.flatMap(o => ((o.datos.colgadas && o.datos.colgadas.mesas) || [])
      .map(m => ({ ...m, mesa: `${o.nombre} · ${m.mesa}`, local: o.id }))),
  };

  const ayer = { fecha: (ds.find(d => d.ayer && d.ayer.fecha) || {}).ayer?.fecha || null, ...sumaBloque(ds, 'ayer') };
  const uni = k => [...new Set(ds.flatMap(d => (d[k] && d[k].jornadas) || []))].filter(Boolean).sort();
  const semana = { desde: (ds[0].semana || {}).desde || null, jornadas: uni('semana'), ...sumaBloque(ds, 'semana') };
  const mes = { desde: (ds[0].mes || {}).desde || null, jornadas: uni('mes'), ...sumaBloque(ds, 'mes') };

  // Curva horaria: se suma hora a hora.
  const porHora = {};
  ds.forEach(d => Object.entries((d.pulso && d.pulso.porHora) || {})
    .forEach(([h, v]) => { porHora[h] = r2((porHora[h] || 0) + (Number(v) || 0)); }));

  // Productos: se acumulan por nombre entre locales y se recalcula el % sobre
  // el total del GRUPO (no se promedian los porcentajes de cada local).
  const uds = {}, eur = {};
  ds.forEach(d => ((d.pulso && d.pulso.rankingEuros) || []).forEach(p => {
    uds[p.producto] = (uds[p.producto] || 0) + (p.uds || 0);
    eur[p.producto] = (eur[p.producto] || 0) + (p.euros || 0);
  }));
  const totalProductosEur = r2(ds.reduce((s, d) => s + ((d.pulso && d.pulso.totalProductosEur) || 0), 0));
  const totalProductosUds = ds.reduce((s, d) => s + ((d.pulso && d.pulso.totalProductosUds) || 0), 0);
  const rankingEuros = Object.keys(eur).sort((a, b) => eur[b] - eur[a]).slice(0, 12).map(p => ({
    producto: p, euros: r2(eur[p]), uds: Math.round(uds[p]),
    pct: totalProductosEur > 0 ? Math.round(eur[p] / totalProductosEur * 1000) / 10 : 0,
  }));
  const top = Object.keys(uds).sort((a, b) => uds[b] - uds[a]).slice(0, 3)
    .map(p => ({ producto: p, uds: Math.round(uds[p]) }));

  return {
    ok: true,
    negocio: {
      id: 'grupo', nombre: 'Todos',
      aforo: ds.reduce((s, d) => s + ((d.negocio && d.negocio.aforo) || 0), 0),
      mesas: ds.reduce((s, d) => s + ((d.negocio && d.negocio.mesas) || 0), 0) || null,
    },
    fecha: ds[0].fecha,
    cerradas, abiertas, control, colgadas, ayer, semana, mes,
    pulso: { porHora, top, rankingEuros, totalProductosEur, totalProductosUds },
    ventasResumen: consolidarVentasResumen(oks),
  };
}

// Consolida el resumen anual (Ventas) de varios negocios en uno solo, con la
// MISMA forma que usa cada negocio por separado, para que "Año" y "Σ Todos"
// se pinten sin cambiar el código que ya los muestra. Suma facturación,
// tickets, comensales, evolución mensual y byDate (día a día). No incluye
// topPlatos/evolucionPorPlato porque la pestaña "Año" del Inicio no los usa.
function consolidarVentasResumen(oks) {
  const rs = oks.map(o => (o.datos && o.datos.ventasResumen) || null).filter(Boolean);
  if (!rs.length) return null;

  const porAño = {};
  rs.forEach(r => {
    Object.entries(r.porAño || {}).forEach(([año, a]) => {
      if (!porAño[año]) porAño[año] = { facturacion: 0, tickets: 0, comensales: 0, evolucionMensual: {}, byDate: {} };
      porAño[año].facturacion += a.facturacion || 0;
      porAño[año].tickets += a.tickets || 0;
      porAño[año].comensales += a.comensales || 0;
      Object.entries(a.evolucionMensual || {}).forEach(([m, eur]) => {
        porAño[año].evolucionMensual[m] = (porAño[año].evolucionMensual[m] || 0) + (Number(eur) || 0);
      });
      // byDate se suma día a día entre negocios (viene solo en año actual y
      // anterior). Es lo que permite que "Σ Todos → Año" recorte al mismo
      // tramo del calendario igual que un local; sin esto, el grupo comparaba
      // el año en curso (parcial) contra el año anterior ENTERO y daba un %
      // negativo absurdo.
      Object.entries(a.byDate || {}).forEach(([d, eur]) => {
        porAño[año].byDate[d] = (porAño[año].byDate[d] || 0) + (Number(eur) || 0);
      });
    });
  });
  Object.values(porAño).forEach(a => {
    a.facturacion = r2(a.facturacion);
    a.ticketMedio = a.tickets > 0 ? r2(a.facturacion / a.tickets) : 0;
    Object.keys(a.evolucionMensual).forEach(m => { a.evolucionMensual[m] = Math.round(a.evolucionMensual[m]); });
    Object.keys(a.byDate).forEach(d => { a.byDate[d] = Math.round(a.byDate[d]); });
  });

  const ventasPeriodo = r2(rs.reduce((s, r) => s + (r.ventasPeriodo || 0), 0));
  const nComensales = rs.reduce((s, r) => s + (r.nComensales || 0), 0);
  const nTickets = rs.reduce((s, r) => s + (r.nTickets || 0), 0);
  // El per cápita del grupo se recalcula sobre el TOTAL sumado, nunca
  // promediando los per cápita de cada negocio (eso falsearía el resultado
  // si un negocio tiene mucho más volumen que el otro).
  const perCapita = nComensales > 0 ? r2(ventasPeriodo / nComensales) : null;

  return { porAño, perCapita, ventasPeriodo, nComensales, nTickets, periodo: rs[0].periodo || '' };
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ ok: false, error: 'Solo GET' }); return; }
  if (!autorizado(req)) { res.status(401).json({ ok: false, error: 'No autorizado' }); return; }

  const lista = locales();
  const quiere = String(req.query.local || '').trim();

  // Sin parámetro: la lista y cuál de ellos es este despliegue, para que el
  // Inicio sepa cuándo está mirando datos ajenos y avise.
  if (!quiere) {
    res.status(200).json({
      ok: true,
      propio: process.env.NEGOCIO_ID || 'talabar',
      locales: lista.map(l => ({ id: l.id, nombre: l.nombre })),
    });
    return;
  }
  if (!lista.length) { res.status(200).json({ ok: false, error: 'No hay grupo configurado' }); return; }

  try {
    if (quiere === 'todos') {
      const rs = await Promise.all(lista.map(pedirLocal));
      const oks = rs.filter(r => r.ok);
      if (!oks.length) { res.status(502).json({ ok: false, error: 'Ningún local respondió' }); return; }
      const out = consolidar(oks);
      // Se informa de qué locales entraron en la suma y cuáles fallaron: una
      // suma incompleta sin avisar sería peor que no dar el dato.
      out.locales = rs.map(r => ({ id: r.id, nombre: r.nombre, ok: r.ok, error: r.error || null,
        euros: r.ok ? r2(((r.datos.cerradas || {}).euros || 0) + ((r.datos.abiertas || {}).euros || 0)) : null }));
      out.parcial = oks.length < lista.length;
      res.status(200).json(out);
      return;
    }
    const l = lista.find(x => x.id === quiere);
    if (!l) { res.status(404).json({ ok: false, error: 'Local desconocido' }); return; }
    const r = await pedirLocal(l);
    if (!r.ok) { res.status(502).json({ ok: false, error: `${l.nombre}: ${r.error}` }); return; }
    res.status(200).json(r.datos);
  } catch (e) {
    console.error('[grupo] fallo:', e.message || e);
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
};

module.exports.consolidarVentasResumen = consolidarVentasResumen;
