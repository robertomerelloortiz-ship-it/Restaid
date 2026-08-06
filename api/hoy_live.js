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

// ── Mesas de control / fantasma ──────────────────────────────────────────
// Mesas que NO son servicio real y no deben contar en el pulso (ficha
// "Abiertas", euros en curso, ocupación ni modal):
//   - "Barra 8": comodín donde se aparcan las comandas equivocadas (control
//     antifraude: se aparcan en vez de borrarlas).
//   - "MESA 24": orden zombi heredada de Revo (abierta desde 2025 y nunca
//     cerrada). OJO: en MAYÚSCULAS. La mesa real de servicio se llama
//     "Mesa 24" y NO se toca — la diferencia de grafía es lo único que las
//     separa.
// La comparación es EXACTA y distingue mayúsculas, a propósito.
// Esto solo afecta a la vista en vivo: las VENTAS no se tocan nunca.
// Configurable en Vercel con MESAS_CONTROL="MESA 24,Barra 8".
// Mesas de control: el "cajón" donde los camareros meten errores en vez de
// borrar líneas (para evitar robos). Nunca cuentan en el pulso ni salen como
// mesas abiertas. Lista base fija (siempre activa) + lo que añada la variable
// de entorno MESAS_CONTROL, por si algún local necesita sumar más.
const CONTROL_BASE = 'MESA 22,MESA 24,MESA 25,Barra 8';
const MESAS_CONTROL = (CONTROL_BASE + ',' + (process.env.MESAS_CONTROL || ''))
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const esMesaControl = m => MESAS_CONTROL.includes(String(m || '').trim().toLowerCase());

// ── Identidad del negocio ────────────────────────────────────────────────
// Cada despliegue (= cada local) se describe a sí mismo. Así el Inicio no
// necesita saber de qué local es, y la vista de grupo puede etiquetar cada
// uno sin listas duplicadas. Se configuran en Vercel:
//   NEGOCIO_ID / NEGOCIO_NOMBRE / AFORO
const NEGOCIO = {
  id: process.env.NEGOCIO_ID || 'talabar',
  nombre: process.env.NEGOCIO_NOMBRE || 'Talabar',
  aforo: parseInt(process.env.AFORO, 10) > 0 ? parseInt(process.env.AFORO, 10) : 84,
};

// Núcleo compartido: la regla de qué es una venta, la jornada de servicio y
// el traductor viven en UN solo sitio (_revo_core.js), no copiados por fichero.
const CORE = require('./_revo_core.js');
const { num, sbHeaders, jornadaDe, CORTE_JORNADA_H, horaInicioActividad } = CORE;

// ── Autorización ─────────────────────────────────────────────────────────
// Este endpoint expone ventas del día, mesas abiertas y nombres de personal:
// nunca debe ser público. Acepta dos llaves:
//   - x-restaid-pass  : la contraseña del local (la del navegador).
//   - x-restaid-grupo : el secreto compartido del grupo, para que el Inicio
//     de un local hermano pueda leer estos totales de servidor a servidor.
//     Nunca baja al navegador.
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

const FMT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
function hoyMadrid() { return FMT.format(new Date()).replace(',', '').slice(0, 10); }

// Jornada de SERVICIO (criterio Revo y de la casa): la madrugada pertenece
// al día anterior. CORTE_JORNADA_H = 4 → el día acaba a las 04:00 (las cenas
// se alargan hasta la 01:30; entre las 04:00 y la apertura no hay actividad).
// Convención única de Talabar: si algún día cambia, cambiarla SOLO en el núcleo.
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

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ ok: false, error: 'Solo GET' }); return; }
  if (!autorizado(req)) { res.status(401).json({ ok: false, error: 'No autorizado' }); return; }
  const URL_SB = process.env.SUPABASE_URL;
  const KEY_SB = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!URL_SB || !KEY_SB) { res.status(500).json({ ok: false, error: 'Supabase no configurado' }); return; }
  try {
    // Red de seguridad. El webhook ya traduce cada cierre en el acto, así que
    // esto normalmente no encuentra nada: es una consulta vacía y barata. Solo
    // recoge lo que falló al vuelo. Lote corto: esta función responde a una
    // pantalla y no puede eternizarse; lo gordo lo barre el cron diario.
    // Si falla, no se corta la lectura: mejor dar el dato que hay que no dar nada.
    try { await CORE.procesarPendientes(URL_SB, KEY_SB, 20); }
    catch (e) { console.warn('[hoy_live] pendientes:', String(e.message || e).slice(0, 120)); }
    // Jornada de servicio (corte 04:00): se consulta por la columna jornada
    const j = jornadaServicio();
    const fecha = j.fecha;
    const ayerJ = (() => { const d = new Date(fecha + 'T12:00:00'); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
    // Semana de jornadas (lunes de la jornada actual) y mes de la jornada
    const dJ = new Date(fecha + 'T12:00:00');
    const lunesOff = dJ.getDay() === 0 ? -6 : 1 - dJ.getDay();
    const lunesJ = new Date(dJ.getTime() + lunesOff * 86400000).toISOString().slice(0, 10);
    const mesJ = fecha.slice(0, 7) + '-01';
    const diaSiguiente = (() => { const d = new Date(fecha + 'T12:00:00'); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); })();
    const [rC, rA, rY, rS, rM, rL, rE] = await Promise.all([
      fetch(`${URL_SB}/rest/v1/ventas_ordenes?select=orden_id,total,comensales,cerrado&jornada=eq.${fecha}&limit=2000`, { headers: sbHeaders(KEY_SB) }),
      fetch(`${URL_SB}/rest/v1/revo_abiertas?select=orden_id,mesa,comensales,empleado,total,lineas,abierta_desde,actualizada_en&order=abierta_desde.asc&limit=200`, { headers: sbHeaders(KEY_SB) }),
      fetch(`${URL_SB}/rest/v1/ventas_ordenes?select=total,comensales&jornada=eq.${ayerJ}&limit=2000`, { headers: sbHeaders(KEY_SB) }),
      fetch(`${URL_SB}/rest/v1/ventas_ordenes?select=total,comensales,jornada&jornada=gte.${lunesJ}&jornada=lte.${fecha}&limit=5000`, { headers: sbHeaders(KEY_SB) }),
      fetch(`${URL_SB}/rest/v1/ventas_ordenes?select=total,comensales,jornada&jornada=gte.${mesJ}&jornada=lte.${fecha}&limit=10000`, { headers: sbHeaders(KEY_SB) }),
      fetch(`${URL_SB}/rest/v1/ventas_lineas?select=producto,cantidad,total,orden_id&fecha=gte.${fecha}&fecha=lte.${diaSiguiente}&limit=5000`, { headers: sbHeaders(KEY_SB) }),
      // Total de mesas del local: lo configura el usuario en Ventas (⚙) y se
      // guarda en ventas_escandallo.datos.__totalMesas__. Va con los datos del
      // local, NO con el navegador, para que sea correcto sea cual sea el link.
      fetch(`${URL_SB}/rest/v1/ventas_escandallo?select=datos&limit=1`, { headers: sbHeaders(KEY_SB) }),
    ]);
    if (!rC.ok) throw new Error('cerradas: HTTP ' + rC.status);
    const cerradasFilas = await rC.json();
    let abiertasFilas = rA.ok ? await rA.json() : [];
    const ayerFilas = rY.ok ? await rY.json() : [];
    // Total de mesas configurado en Ventas (0/ausente si aún no se ha puesto).
    let mesasLocal = 0;
    try { if (rE && rE.ok) { const _e = await rE.json(); const _d = _e && _e[0] && _e[0].datos; if (_d && _d.__totalMesas__ > 0) mesasLocal = _d.__totalMesas__; } } catch (e) {}

    // Autolimpieza de mesas fantasma cuyo evento de cierre/anulación nunca
    // llegó. Se excluyen del conteo y se borran en segundo plano (sin bloquear
    // la respuesta). Dos casos:
    //   (1) Aperturas rancias: 0 € y >6 h sin actualizarse (aperturas vacías
    //       abandonadas/anuladas).
    //   (2) Fantasmas con dinero: importe > 0 pero SIN una sola actualización
    //       en 3 h+, dentro de la jornada de hoy. Es el pago rápido que Revo
    //       cobra sin emitir order.closed: la mesa se fue de Revo pero la fila
    //       sigue aquí. Una mesa viva recibe order.updated al añadirle cosas;
    //       3 h congelada = ya no está. Se limita a la jornada actual para no
    //       pisar el guardarraíl de jornada (las de días anteriores salen como
    //       "colgadas", que el dueño revisa y anula a mano).
    const AHORA = Date.now();
    const esFantasma = a => {
      const ref = a.actualizada_en || a.abierta_desde;
      const edadH = ref ? (AHORA - new Date(ref).getTime()) / 3600000 : 999;
      const tot = num(a.total) || 0;
      if (tot === 0 && edadH >= 6) return true;
      const jorn = a.abierta_desde ? jornadaDe(String(a.abierta_desde)) : null;
      if (tot > 0 && edadH >= 3 && jorn === fecha) return true;
      return false;
    };
    const fantasmas = abiertasFilas.filter(esFantasma);
    abiertasFilas = abiertasFilas.filter(a => !esFantasma(a));
    if (fantasmas.length) {
      const idsF = fantasmas.map(a => a.orden_id);
      fetch(`${URL_SB}/rest/v1/revo_abiertas?orden_id=in.(${idsF.join(',')})`, { method: 'DELETE', headers: sbHeaders(KEY_SB) })
        .then(() => console.log('[hoy_live] limpiadas', idsF.length, 'mesas fantasma:', idsF.join(',')))
        .catch(() => {});
    }

    // Mesas de control/comodín y zombis heredados: fuera del pulso. No son
    // servicio real, así que falsean el conteo, los euros en curso y la
    // ocupación, y disparan la alerta de "lleva mucho abierta" cada día.
    // Se devuelven aparte por si se quieren consultar; las ventas no se tocan.
    const controlFilas = abiertasFilas.filter(a => esMesaControl(a.mesa));
    abiertasFilas = abiertasFilas.filter(a => !esMesaControl(a.mesa));

    // Guardarraíl de jornada: una mesa abierta ANTES del inicio de la jornada
    // de servicio actual (corte 04:00) no es una mesa viva de hoy, sea cual
    // sea su nombre o su dinero. Sale del pulso y se devuelve como "colgada"
    // para que el dueño la vea y la anule en Revo. Genérico: no depende de
    // listas de mesas y cubre cualquier zombi futuro.
    const esDeJornadaAnterior = a => {
      if (!a.abierta_desde) return false;
      const j = jornadaDe(String(a.abierta_desde));
      return j && j < fecha; // `fecha` es la jornada de servicio actual
    };
    const colgadasFilas = abiertasFilas.filter(esDeJornadaAnterior);
    abiertasFilas = abiertasFilas.filter(a => !esDeJornadaAnterior(a));
    const colgadas = {
      n: colgadasFilas.length,
      euros: Math.round(colgadasFilas.reduce((s, o) => s + num(o.total), 0) * 100) / 100,
      mesas: colgadasFilas.map(o => ({ mesa: o.mesa, total: num(o.total), abierta_desde: o.abierta_desde || null })),
    };

    const cerradas = {
      euros: Math.round(cerradasFilas.reduce((s, o) => s + num(o.total), 0) * 100) / 100,
      n: cerradasFilas.length,
      comensales: cerradasFilas.reduce((s, o) => s + (o.comensales || 0), 0),
    };
    const control = {
      n: controlFilas.length,
      euros: Math.round(controlFilas.reduce((s, o) => s + num(o.total), 0) * 100) / 100,
      mesas: controlFilas.map(o => ({ mesa: o.mesa, total: num(o.total), abierta_desde: o.abierta_desde || null })),
    };
    const abiertas = {
      euros: Math.round(abiertasFilas.reduce((s, o) => s + num(o.total), 0) * 100) / 100,
      n: abiertasFilas.length,
      comensales: abiertasFilas.reduce((s, o) => s + (o.comensales || 0), 0),
      mesas: abiertasFilas
        .slice()
        .sort((a, b) => String(a.abierta_desde || '').localeCompare(String(b.abierta_desde || '')))
        .map(o => ({
          mesa: o.mesa, total: num(o.total), comensales: o.comensales,
          empleado: o.empleado || null,
          desde: o.abierta_desde ? String(o.abierta_desde).slice(11, 16) : null,
          abierta_desde: o.abierta_desde || null,
          // Desglose para el modal del Inicio (pulsar la mesa). Puede ser
          // null en mesas abiertas ANTES de desplegar esta versión: el
          // detalle solo llega con el siguiente marcaje de esa mesa.
          lineas: Array.isArray(o.lineas) ? o.lineas : null,
        })),
    };
    const ayer = {
      fecha: ayerJ,
      euros: Math.round(ayerFilas.reduce((s, o) => s + num(o.total), 0) * 100) / 100,
      n: ayerFilas.length,
      comensales: ayerFilas.reduce((s, o) => s + (o.comensales || 0), 0),
    };
    // ── Pulso del servicio ──
    // Curva horaria: facturación por hora de cierre (madrugada 00-03 al final)
    const porHora = {};
    for (const o of cerradasFilas) {
      if (!o.cerrado) continue;
      const h = parseInt(String(o.cerrado).slice(11, 13), 10);
      if (isNaN(h)) continue;
      const k = String(h).padStart(2, '0');
      porHora[k] = Math.round(((porHora[k] || 0) + num(o.total)) * 100) / 100;
    }
    // Antes el HTML fijaba el arranque de la curva a las 12h, pensado para
    // Talabar. Con negocios que abren antes (La Canilla, sobre las 8), la
    // curva se comía toda la mañana. Se calcula aquí, con datos reales, para
    // que sirva igual para cualquier negocio sin tocar código cada vez.
    const horaInicio = horaInicioActividad(cerradasFilas, abiertasFilas);
    // Top productos: líneas de las órdenes cerradas de la jornada
    const idsCerradas = new Set(cerradasFilas.map(o => o.orden_id));
    const lineasFilas = rL && rL.ok ? await rL.json() : [];
    const porProducto = {};   // unidades
    const eurosProducto = {}; // € facturados
    let totalLineasEur = 0, totalLineasUds = 0;
    for (const l of lineasFilas) {
      if (!idsCerradas.has(l.orden_id)) continue;
      porProducto[l.producto] = (porProducto[l.producto] || 0) + num(l.cantidad);
      eurosProducto[l.producto] = (eurosProducto[l.producto] || 0) + num(l.total);
      totalLineasEur += num(l.total);
      totalLineasUds += num(l.cantidad);
    }
    const top = Object.keys(porProducto)
      .sort((a, b) => porProducto[b] - porProducto[a])
      .slice(0, 3)
      .map(p => ({ producto: p, uds: Math.round(porProducto[p]) }));
    // Ranking por DINERO (top 12) para el modal de productos
    const rankingEuros = Object.keys(eurosProducto)
      .sort((a, b) => eurosProducto[b] - eurosProducto[a])
      .slice(0, 12)
      .map(p => ({
        producto: p,
        euros: Math.round(eurosProducto[p] * 100) / 100,
        uds: Math.round(porProducto[p]),
        pct: totalLineasEur > 0 ? Math.round(eurosProducto[p] / totalLineasEur * 1000) / 10 : 0,
      }));

    const suma = filas => ({
      euros: Math.round(filas.reduce((s, o) => s + num(o.total), 0) * 100) / 100,
      n: filas.length,
      comensales: filas.reduce((s, o) => s + (o.comensales || 0), 0),
    });
    const semFilas = rS.ok ? await rS.json() : [];
    const mesFilas = rM.ok ? await rM.json() : [];
    // Jornadas con datos en el mes (para detectar huecos tipo 1-9 julio)
    const jornadasMes = [...new Set(mesFilas.map(o => o.jornada))].sort();
    const jornadasSem = [...new Set(semFilas.map(o => o.jornada))].filter(Boolean).sort();
    const semana = { desde: lunesJ, jornadas: jornadasSem, ...suma(semFilas) };
    const mes = { desde: mesJ, jornadas: jornadasMes, ...suma(mesFilas) };
    res.status(200).json({ ok: true, negocio: { ...NEGOCIO, mesas: mesasLocal || null }, fecha, cerradas, abiertas, control, colgadas, ayer, semana, mes, pulso: { porHora, horaInicio, top, rankingEuros, totalProductosEur: Math.round(totalLineasEur * 100) / 100, totalProductosUds: totalLineasUds } });
  } catch (e) {
    console.error('[hoy_live] fallo:', e.message || e);
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
};
