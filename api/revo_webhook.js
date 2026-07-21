// /api/revo_webhook.js — Receptor de webhooks de Revo XEF (Cegid).
//
// Revo llama a esta URL cada vez que ocurre un evento (p. ej. se cierra
// una mesa → order.closed). Verificamos la firma HMAC, y guardamos el
// evento CRUDO en Supabase (tabla revo_eventos). Los módulos de RESTAID
// leen de ahí; si algo falla en el procesado posterior, el dato nunca
// se pierde.
//
// v4 (17-jul-2026): además de archivar el crudo, TRADUCE el cierre a Piso 2
// (ventas_ordenes + ventas_lineas) en el acto. Antes esa traducción la pagaba
// quien abriera el Inicio, que se comía hasta 50 eventos en serie antes de
// pintar un número. Ahora la espera la pone Revo, que no está mirando la
// pantalla. Si la traducción falla, el evento queda pendiente y lo recogen la
// red de seguridad del Inicio o el cron diario de /api/revo_traductor: NUNCA
// devuelve error por eso (ver la nota sobre el retry count, más abajo).
//
// Variables de entorno (Vercel):
//   REVO_WEBHOOK_SECRET   — la clave secreta que genera Revo al crear el
//                           primer webhook (página account/webhooks)
//   SUPABASE_URL          — ya existe
//   SUPABASE_SERVICE_KEY  — ya existe (fallback: SUPABASE_KEY)
//
// Tabla Supabase necesaria (crear una vez en el SQL editor):
//   create table revo_eventos (
//     id bigint generated always as identity primary key,
//     recibido_en timestamptz default now(),
//     tenant text,
//     event text,
//     data jsonb,
//     procesado boolean default false
//   );
//
// v3 (11-jul-2026): además de guardar order.closed, mantiene la tabla
// revo_abiertas con las mesas abiertas AHORA MISMO (para el dashboard):
//   - order.created / order.updated (status 0) → upsert en revo_abiertas
//   - order.closed / cancelled / merged / deleted → se borra de revo_abiertas
// Requiere dar de alta en Revo los webhooks adicionales (misma URL):
//   order.created, order.updated, order.cancelled, order.merged
//
// Respuestas:
//   200 → Revo da el envío por bueno (también para eventos que ignoramos,
//         para que no reintente ni desactive el webhook)
//   401 → firma inválida (posible impostor)
//   500 → fallo al guardar; Revo reintentará (10s, 30s, 1m, 2m, 5m)
//
// IMPORTANTE (retry count): si esta URL falla 5 tandas seguidas, Revo
// DESACTIVA el webhook. Vigilar en el dashboard que siguen llegando eventos.

const crypto = require('crypto');
// Núcleo compartido: la misma regla de "qué es una venta" que usan el traductor
// y el Inicio. Traducir aquí con una copia propia sería garantizar que un día
// el webhook y el histórico cuenten cosas distintas.
const CORE = require('./_revo_core.js');

// ── Mesas de control / fantasma ──────────────────────────────────────────
// No se registran en revo_abiertas: no son servicio real y falsean el pulso
// del dashboard (conteo, euros en curso, ocupación y alerta de tiempo).
//   - "Barra 8": comodín para aparcar comandas equivocadas (control antifraude).
//   - "MESA 24": orden zombi de Revo abierta desde 2025, nunca cerrada.
// OJO: comparación EXACTA y sensible a mayúsculas. La mesa real de servicio
// es "Mesa 24" y sigue funcionando con normalidad.
// Esto NO afecta a las ventas: los order.closed se archivan igual que siempre.
// Configurable en Vercel con MESAS_CONTROL="MESA 24,Barra 8".
const MESAS_CONTROL = (process.env.MESAS_CONTROL || 'MESA 24,Barra 8')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const esMesaControl = m => MESAS_CONTROL.includes(String(m || '').trim().toLowerCase());

// ── Núcleo puro (testeado en test_webhook_core.js) ──────────────────────

const EVENTOS_ACEPTADOS = new Set(['order.closed']);

function comparaSegura(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verificarFirma(rawBody, firmaHeader, secret) {
  if (!firmaHeader || !secret) return false;
  const b64 = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  const hex = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  return comparaSegura(firmaHeader, b64) || comparaSegura(firmaHeader, hex);
}

function parsearEvento(rawBody, contentType) {
  if (!rawBody) return null;
  let obj = null;
  // Revo declara x-www-form-urlencoded pero envía JSON: decidimos por el
  // contenido real (primer carácter), no por la cabecera.
  const pareceJson = rawBody.trim().startsWith('{');
  if (pareceJson || (contentType || '').includes('json')) {
    try { obj = JSON.parse(rawBody); } catch (_) { return null; }
  } else {
    const params = new URLSearchParams(rawBody);
    obj = {};
    for (const [k, v] of params) obj[k] = v;
    if (typeof obj.data === 'string') {
      try { obj.data = JSON.parse(obj.data); } catch (_) { /* queda como string */ }
    }
  }
  if (!obj || !obj.event) return null;
  return { tenant: obj.tenant || null, event: obj.event, data: obj.data !== undefined ? obj.data : null };
}

function eventoAceptado(event) {
  return EVENTOS_ACEPTADOS.has(event || '');
}

// ── Handler HTTP ─────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Método no permitido (solo POST)' });
    return;
  }

  // Cuerpo CRUDO: imprescindible leerlo sin parsear para verificar la firma.
  let rawBody = '';
  try {
    rawBody = await new Promise((resolve, reject) => {
      let d = '';
      req.on('data', c => (d += c));
      req.on('end', () => resolve(d));
      req.on('error', reject);
    });
  } catch (_) {
    res.status(400).json({ ok: false, error: 'No se pudo leer el cuerpo' });
    return;
  }

  const secret = process.env.REVO_WEBHOOK_SECRET;
  const firma = req.headers['x-revo-hmac-sha256'];
  if (!verificarFirma(rawBody, firma, secret)) {
    res.status(401).json({ ok: false, error: 'Firma inválida' });
    return;
  }

  const evento = parsearEvento(rawBody, req.headers['content-type'] || '');
  if (!evento) {
    // Firma válida pero cuerpo raro: 200 para no forzar reintentos inútiles.
    console.log('[revo_webhook] cuerpo sin evento. content-type:', req.headers['content-type'],
      '| primeros 500 chars:', rawBody.slice(0, 500));
    res.status(200).json({ ok: true, ignorado: 'cuerpo sin evento' });
    return;
  }

  const ABIERTA_UPSERT = new Set(['order.created', 'order.updated']);
  const ABIERTA_BORRAR = new Set(['order.closed', 'order.cancelled', 'order.merged', 'order.deleted']);
  const esGestionAbiertas = ABIERTA_UPSERT.has(evento.event) || ABIERTA_BORRAR.has(evento.event);

  if (!eventoAceptado(evento.event) && !esGestionAbiertas) {
    // Evento que aún no procesamos: 200 para que Revo no reintente
    // ni acabe desactivando el webhook.
    console.log('[revo_webhook] evento ignorado:', evento.event, '| tenant:', evento.tenant);
    res.status(200).json({ ok: true, ignorado: evento.event });
    return;
  }

  // Guardar el evento crudo en Supabase (tabla revo_eventos).
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    res.status(500).json({ ok: false, error: 'Supabase no configurado' });
    return;
  }

  // ── Mesas abiertas (tabla revo_abiertas) — nunca bloquea la respuesta ──
  try {
    const d = evento.data || {};
    const sb = {
      'Content-Type': 'application/json', apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    };
    if (ABIERTA_UPSERT.has(evento.event) && d.id && d.status === 0 && !d.canceled && !esMesaControl(d.tableName)) {
      const aMadrid = s => {
        if (!s) return null;
        const dt = new Date(String(s).replace(' ', 'T') + 'Z');
        if (isNaN(dt)) return null;
        return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(dt).replace(',', '');
      };
      const numV = v => { const n = parseFloat(String(v ?? 0).replace(',', '.')); return isNaN(n) ? 0 : n; };
      await fetch(`${SUPABASE_URL}/rest/v1/revo_abiertas?on_conflict=orden_id`, {
        method: 'POST',
        headers: { ...sb, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{
          orden_id: d.id,
          mesa: d.tableName || null,
          comensales: Math.max(1, numV(d.guests) || 1),
          empleado: d.tenantUserName || null,
          total: numV(d.sum || d.total),
          // Desglose de lo marcado hasta ahora, para poder pulsarla en el
          // Inicio y ver qué lleva la mesa sin ir a Revo. Cada order.updated
          // trae el contenido completo, así que la última foto siempre gana.
          lineas: CORE.lineasAbiertas(d),
          abierta_desde: aMadrid(d.opened || d.created_at),
          actualizada_en: new Date().toISOString(),
        }]),
      });
    } else if (ABIERTA_UPSERT.has(evento.event) && d.id) {
      // Un created/updated con status ≠ 0 o cancelado significa que la orden
      // YA NO está abierta (cobro rápido, cierre que llega como updated).
      // Antes este caso no entraba en ninguna rama y la mesa quedaba
      // atascada para siempre con dinero (la autolimpieza solo barre 0 €).
      await fetch(`${SUPABASE_URL}/rest/v1/revo_abiertas?orden_id=eq.${d.id}`, {
        method: 'DELETE', headers: sb,
      });
    } else if (ABIERTA_BORRAR.has(evento.event) && d.id) {
      await fetch(`${SUPABASE_URL}/rest/v1/revo_abiertas?orden_id=eq.${d.id}`, {
        method: 'DELETE', headers: sb,
      });
    }
  } catch (e) {
    console.warn('[revo_webhook] gestión abiertas falló (no bloquea):', String(e).slice(0, 120));
  }

  if (!eventoAceptado(evento.event)) {
    // Evento solo de gestión de abiertas: no se archiva en revo_eventos.
    res.status(200).json({ ok: true, abiertas: evento.event });
    return;
  }

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/revo_eventos?select=id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        // Se pide que devuelva la fila para saber su id exacto y poder marcarla
        // procesada tras traducirla. Buscarla luego por el id de la orden sería
        // dar un rodeo y arriesgarse a marcar la fila equivocada.
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        tenant: evento.tenant,
        event: evento.event,
        data: evento.data,
      }),
    });
    if (!r.ok) {
      const detalle = await r.text().catch(() => '');
      // 500 → Revo reintentará (10s, 30s, 1m, 2m, 5m)
      res.status(500).json({ ok: false, error: 'Fallo al guardar', detalle: detalle.slice(0, 200) });
      return;
    }

    // ── Traducción al vuelo: Piso 1 → Piso 2 ──────────────────────────────
    // Antes, el evento se quedaba en crudo hasta que alguien abría el Inicio, y
    // era ESA pantalla la que pagaba el traducir (hasta 50 eventos en serie
    // antes de enseñar un solo número). Traducirlo aquí cuesta lo mismo, pero
    // lo espera Revo, no el que mira el dashboard. Además el Piso 2 queda al
    // día solo, sin depender de que nadie abra nada.
    //
    // Reglas de oro de este bloque:
    //   1. Va DESPUÉS de archivar el crudo: si falla, el dato no se pierde.
    //   2. No puede cambiar la respuesta. Un fallo aquí deja el evento con
    //      procesado=false y lo recogen la red de seguridad del Inicio o el
    //      cron diario. Si esto devolviera 500, Revo reintentaría un evento YA
    //      archivado y, a las cinco tandas, desactivaría el webhook: perderíamos
    //      las ventas por no saber traducir una.
    // El id de la fila recién archivada, para marcarla procesada al traducirla.
    const filaId = await r.json().then(a => (Array.isArray(a) && a[0] ? a[0].id : null)).catch(() => null);

    let traducido = false;
    try {
      const t = CORE.transformarEvento(evento.data);
      // Si t es null, es un cierre intermedio o una cancelada: no entra al
      // histórico, pero se marca procesada para que nadie la revise eternamente.
      if (t) await CORE.guardarOrden(SUPABASE_URL, SUPABASE_KEY, t);
      traducido = true;
      if (filaId != null) {
        await fetch(`${SUPABASE_URL}/rest/v1/revo_eventos?id=eq.${filaId}`, {
          method: 'PATCH',
          headers: { ...CORE.sbHeaders(SUPABASE_KEY), Prefer: 'return=minimal' },
          body: JSON.stringify({ procesado: true }),
        });
      }
    } catch (e) {
      traducido = false;
      console.warn('[revo_webhook] traducción al vuelo falló (queda pendiente):',
        String(e.message || e).slice(0, 150));
    }

    console.log('[revo_webhook] guardado:', evento.event, '| tenant:', evento.tenant, '| traducido:', traducido);
    res.status(200).json({ ok: true, traducido });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Excepción al guardar', detalle: String(e).slice(0, 200) });
  }
};

// Exportado para tests
module.exports.verificarFirma = verificarFirma;
module.exports.parsearEvento = parsearEvento;
module.exports.eventoAceptado = eventoAceptado;
