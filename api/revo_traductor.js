// /api/revo_traductor.js — Traductor: revo_eventos → histórico limpio.
//
// Coge los eventos order.closed pendientes (procesado=false), los convierte
// en filas limpias (ventas_ordenes + ventas_lineas, hora española) y los
// marca como procesados. Idempotente: reprocesar no duplica (upsert por id).
//
// QUÉ PAPEL JUEGA AHORA (jul-2026): desde que revo_webhook.js traduce cada
// cierre en el acto, esto ya no es la vía principal, sino la RED DE SEGURIDAD:
// recoge los eventos cuya traducción falló (Supabase caído un instante, un
// evento con forma rara). En un día normal encuentra cero pendientes.
// Por eso basta con que se ejecute una vez al día (ver "crons" en vercel.json).
//
// Uso:
//   GET/POST /api/revo_traductor?key=LA_LLAVE      (manual, llave propia)
//   GET      /api/revo_traductor                    (cron de Vercel, Bearer CRON_SECRET)
// Respuesta: { ok, procesados, descartados, errores }
//
// Variables de entorno: SUPABASE_URL, SUPABASE_SERVICE_KEY (o SUPABASE_KEY),
// RESTAID_TRADUCTOR_KEY. CRON_SECRET la pone Vercel sola al usar crons.
//
// Tablas (crear una vez en el SQL editor de Supabase — ver traductor_tablas.sql).

const CORE = require('./_revo_core.js');

// Dos maneras legítimas de entrar:
//   1. La llave de siempre (?key= o cabecera x-restaid-key), para lanzarlo a mano.
//   2. El cron de Vercel, que llama por GET con "Authorization: Bearer CRON_SECRET".
//      CRON_SECRET la genera Vercel sola; así la llave NO viaja en vercel.json,
//      que va a GitHub. Un secreto en el repo no es un secreto.
function autorizado(req) {
  const llaveOK = process.env.RESTAID_TRADUCTOR_KEY;
  const llave = (req.query && req.query.key) || req.headers['x-restaid-key'];
  if (llaveOK && llave && String(llave) === String(llaveOK)) return true;

  const cronOK = process.env.CRON_SECRET;
  const auth = req.headers['authorization'] || '';
  if (cronOK && auth === `Bearer ${cronOK}`) return true;

  return false;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Método no permitido' });
    return;
  }

  if (!autorizado(req)) {
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
    // Máx 200 por pasada para no eternizar la función.
    const r = await CORE.procesarPendientes(URL_SB, KEY_SB, 200);
    console.log(`[revo_traductor] procesados=${r.procesados} descartados=${r.descartados} errores=${r.errores.length}`);
    res.status(200).json({ ok: true, ...r });
  } catch (e) {
    console.error('[revo_traductor] fallo:', e.message || e);
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
};

// Exportado para tests. El núcleo vive ahora en _revo_core.js; se re-exporta
// desde aquí para no romper nada que ya lo importara de este fichero.
module.exports.transformarEvento = CORE.transformarEvento;
module.exports.jornadaDe = CORE.jornadaDe;
module.exports.utcAMadrid = CORE.utcAMadrid;
module.exports.num = CORE.num;
module.exports.autorizado = autorizado;
