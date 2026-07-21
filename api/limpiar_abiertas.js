// /api/limpiar_abiertas.js — Barrido de mesas fantasma en revo_abiertas.
//
// Una mesa se queda "colgada" si el webhook recibió su apertura pero no el
// evento que la cierra/anula (order.closed/cancelled/merged/deleted). Causas:
// esos webhooks no estaban dados de alta, el borrado cayó en un redespliegue,
// o —lo más común— fue un PAGO RÁPIDO: Revo lo cobra y lo saca de su lista de
// abiertas SIN emitir order.closed, así que nuestra fila nunca se borra.
//
// Este barrido quita de revo_abiertas:
//   1. Las que YA están cerradas en el histórico (existe la orden en ventas_ordenes).
//   2. Las que ya se archivaron como order.closed en revo_eventos.
//   3. Las "rancias": total 0 y sin actualizarse desde hace más de `horas` (por
//      defecto 6) — aperturas abandonadas/anuladas cuyo borrado nunca llegó.
//   4. Las "fantasma con dinero": CUALQUIER total pero sin una sola
//      actualización desde hace más de `horasFantasma` (por defecto 3). Una mesa
//      viva recibe order.updated cada vez que se le añade algo; si lleva horas
//      congelada es un pago rápido que ya se fue de Revo. El umbral de 3h deja
//      margen de sobra para una comida larga real (que sí genera updates).
//
// Uso:
//   ENSAYO: GET /api/limpiar_abiertas?key=LA_LLAVE&dry=1
//   REAL:   GET /api/limpiar_abiertas?key=LA_LLAVE
//   (umbrales configurables: &horas=6 para rancias, &horasFantasma=3 para fantasmas)

function sbHeaders(key) {
  return { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` };
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ ok: false, error: 'Solo GET' }); return; }
  const llave = (req.query && req.query.key) || req.headers['x-restaid-key'];
  if (!process.env.RESTAID_TRADUCTOR_KEY || llave !== process.env.RESTAID_TRADUCTOR_KEY) {
    res.status(401).json({ ok: false, error: 'Llave inválida' }); return;
  }
  const dry = String((req.query && req.query.dry) || '') === '1';
  const horas = Math.max(1, parseInt((req.query && req.query.horas) || '6', 10) || 6);
  // Umbral para mesas fantasma con dinero. Nunca por debajo de 2h, para no
  // pillar mesas activas que solo llevan un rato sin comanda nueva.
  const horasFantasma = Math.max(2, parseInt((req.query && req.query.horasFantasma) || '3', 10) || 3);

  const URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!URL || !KEY) { res.status(500).json({ ok: false, error: 'Supabase no configurado' }); return; }

  try {
    // 1. Todas las abiertas actuales
    const rA = await fetch(`${URL}/rest/v1/revo_abiertas?select=orden_id,mesa,total,abierta_desde,actualizada_en&limit=500`, { headers: sbHeaders(KEY) });
    if (!rA.ok) throw new Error('leyendo abiertas: HTTP ' + rA.status);
    const abiertas = await rA.json();
    if (!abiertas.length) { res.status(200).json({ ok: true, revisadas: 0, a_borrar: [] }); return; }

    const ids = abiertas.map(a => a.orden_id);

    // 2. ¿Cuáles ya están cerradas en el histórico?
    const rO = await fetch(`${URL}/rest/v1/ventas_ordenes?select=orden_id&orden_id=in.(${ids.join(',')})`, { headers: sbHeaders(KEY) });
    const cerradasHist = new Set(rO.ok ? (await rO.json()).map(x => x.orden_id) : []);

    // 3. ¿Cuáles se archivaron como order.closed?
    const rE = await fetch(`${URL}/rest/v1/revo_eventos?select=data&event=eq.order.closed&limit=5000`, { headers: sbHeaders(KEY) });
    const cerradasEvento = new Set();
    if (rE.ok) {
      for (const ev of await rE.json()) {
        const id = ev.data && ev.data.id;
        if (id && ids.includes(id)) cerradasEvento.add(id);
      }
    }

    // 4. Clasificar
    const ahora = Date.now();
    const aBorrar = [];
    for (const a of abiertas) {
      let motivo = null;
      const ref = a.actualizada_en || a.abierta_desde;
      const edadH = ref ? (ahora - new Date(ref).getTime()) / 3600000 : 999;
      const tot = parseFloat(a.total) || 0;

      if (cerradasHist.has(a.orden_id)) motivo = 'ya cerrada (histórico)';
      else if (cerradasEvento.has(a.orden_id)) motivo = 'ya cerrada (evento archivado)';
      else if (tot === 0 && edadH >= horas) motivo = `rancia (${Math.round(edadH)}h sin consumo)`;
      else if (edadH >= horasFantasma) motivo = `fantasma (${edadH.toFixed(1)}h sin actividad, ${tot.toFixed(2)}€ sin cierre)`;

      if (motivo) aBorrar.push({ orden_id: a.orden_id, mesa: a.mesa, total: a.total, motivo });
    }

    if (dry) {
      res.status(200).json({ ok: true, modo: 'ENSAYO', revisadas: abiertas.length, a_borrar: aBorrar, se_conservan: abiertas.length - aBorrar.length });
      return;
    }

    let borradas = 0;
    if (aBorrar.length) {
      const idsDel = aBorrar.map(x => x.orden_id);
      const rD = await fetch(`${URL}/rest/v1/revo_abiertas?orden_id=in.(${idsDel.join(',')})`, { method: 'DELETE', headers: sbHeaders(KEY) });
      if (!rD.ok) throw new Error('borrando: HTTP ' + rD.status);
      borradas = idsDel.length;
    }
    console.log(`[limpiar_abiertas] revisadas=${abiertas.length} borradas=${borradas}`);
    res.status(200).json({ ok: true, revisadas: abiertas.length, borradas, detalle: aBorrar });
  } catch (e) {
    console.error('[limpiar_abiertas] fallo:', e.message || e);
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
};
