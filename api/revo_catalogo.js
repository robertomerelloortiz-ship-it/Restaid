// /api/revo_catalogo.js — Sincroniza el catálogo de productos de Revo
// (id → nombre → categoría real) a la tabla revo_catalogo de Supabase.
//
// Es la fuente de verdad de categorías para las ventas que entran por
// webhook/backfill: sin él, los productos nuevos de la carta caerían en
// "Sin cat" y desviarían lentamente el reparto cocina/bebida (la misma
// enfermedad que corrompió el resumen 2026, en versión lenta).
//
// Uso:
//   ENSAYO (ver estructura real, no escribe): GET /api/revo_catalogo?key=LA_LLAVE&dry=1
//   REAL:                                     GET /api/revo_catalogo?key=LA_LLAVE
//
// Tabla (crear una vez en Supabase → SQL Editor):
//   create table if not exists revo_catalogo (
//     item_id bigint primary key,
//     producto text not null,
//     categoria text,
//     grupo text,
//     precio numeric(10,2),
//     activo boolean default true,
//     actualizado_en timestamptz default now()
//   );

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return isNaN(n) ? null : n;
}

/** Mapea un item del catálogo con tolerancia a dialectos (se afinará con el
 *  ensayo, como hicimos con el reporte de órdenes). */
function mapearItem(it) {
  if (!it || it.id === undefined || it.id === null) return null;
  const nombre = it.name || it.nom || it.nombre || it.producte || null;
  if (!nombre) return null;
  // La categoría puede venir anidada (objeto) o plana (nombre/id)
  const cat = it.category || it.categoria || it.group || it.grup || null;
  const categoria = cat && typeof cat === 'object' ? (cat.name || cat.nom || null) : (typeof cat === 'string' ? cat : null);
  const grupoObj = it.superGroup || it.supergroup || it.parent || null;
  const grupo = grupoObj && typeof grupoObj === 'object' ? (grupoObj.name || grupoObj.nom || null) : (typeof grupoObj === 'string' ? grupoObj : null);
  return {
    item_id: it.id,
    producto: String(nombre),
    categoria: categoria || null,
    grupo: grupo || null,
    precio: num(it.price ?? it.preu),
    activo: it.active !== undefined ? !!it.active : (it.actiu !== undefined ? !!it.actiu : true),
  };
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
  const dry = String((req.query && req.query.dry) || '') === '1';

  const token = process.env.REVO_TOKEN;
  if (!token) { res.status(500).json({ ok: false, error: 'Falta REVO_TOKEN' }); return; }
  const isLegacy = token.length < 50;
  const BASE = isLegacy ? 'https://revoxef.works' : 'https://api.integrations.revoxef.works';
  const PATH = isLegacy ? '/api/external/v2/catalog/items' : '/classic/catalog/items';
  if (isLegacy && !process.env.REVO_TENANT) {
    res.status(500).json({ ok: false, error: 'Token legacy: falta REVO_TENANT' }); return;
  }
  const revoHeaders = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
  if (isLegacy) revoHeaders.tenant = process.env.REVO_TENANT;

  const URL_SB = process.env.SUPABASE_URL;
  const KEY_SB = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!dry && (!URL_SB || !KEY_SB)) { res.status(500).json({ ok: false, error: 'Supabase no configurado' }); return; }

  try {
    // ── 1. Descargar catálogo completo (paginación Laravel) ──
    const items = [];
    let page = 1, lastPage = 1, debugPrimera = null;
    do {
      const r = await fetch(`${BASE}${PATH}?page=${page}`, { headers: revoHeaders });
      const texto = await r.text();
      let cuerpo = {};
      try { cuerpo = JSON.parse(texto); } catch (_) {}
      if (page === 1) {
        debugPrimera = {
          url: `${BASE}${PATH}?page=1`, http: r.status,
          claves_respuesta: cuerpo && typeof cuerpo === 'object' ? Object.keys(cuerpo).slice(0, 15) : typeof cuerpo,
          primeros_600_chars: texto.slice(0, 600),
        };
      }
      if (!r.ok) throw new Error(`Revo HTTP ${r.status} (pág ${page}): ${texto.slice(0, 200)}`);
      const lote = Array.isArray(cuerpo) ? cuerpo : Array.isArray(cuerpo.data) ? cuerpo.data : [];
      items.push(...lote);
      lastPage = cuerpo.last_page || (cuerpo.meta && cuerpo.meta.last_page) || 1;
      page++;
    } while (page <= lastPage && page <= 60);

    // ── 2. Mapear ──
    const mapeados = [];
    let sinMapear = 0;
    for (const it of items) {
      const m = mapearItem(it);
      if (m) mapeados.push(m); else sinMapear++;
    }
    const conCategoria = mapeados.filter(m => m.categoria).length;

    // ── 3. Ensayo ──
    if (dry) {
      res.status(200).json({
        ok: true, modo: 'ENSAYO (no se ha escrito nada)',
        items_recibidos: items.length,
        mapeados: mapeados.length, sin_mapear: sinMapear,
        con_categoria: conCategoria,
        muestra_item_crudo: items[0] || null,
        muestra_mapeada: mapeados[0] || null,
        diagnostico: debugPrimera,
      });
      return;
    }

    // ── 4. Escritura real por lotes ──
    let guardados = 0;
    const errores = [];
    for (let i = 0; i < mapeados.length; i += 200) {
      const lote = mapeados.slice(i, i + 200).map(m => ({ ...m, actualizado_en: new Date().toISOString() }));
      const r = await fetch(`${URL_SB}/rest/v1/revo_catalogo?on_conflict=item_id`, {
        method: 'POST',
        headers: { ...sbHeaders(KEY_SB), Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(lote),
      });
      if (!r.ok) { errores.push('lote ' + i + ': HTTP ' + r.status); continue; }
      guardados += lote.length;
    }

    console.log(`[revo_catalogo] items=${items.length} guardados=${guardados} con_categoria=${conCategoria} errores=${errores.length}`);
    res.status(200).json({ ok: true, items_recibidos: items.length, guardados, con_categoria: conCategoria, errores });
  } catch (e) {
    console.error('[revo_catalogo] fallo:', e.message || e);
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
};
