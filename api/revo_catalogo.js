// /api/revo_catalogo.js — Sincroniza el catálogo de Revo (v2).
//
// v2, tras ensayo real (11-jul-2026, 1.153 items): los productos traen
// category_id (número), no el nombre. Se descarga también la lista de
// categorías (/classic/catalog/categories) y se cruzan. De paso se captura
// costPrice (precio de coste) para el escandallo futuro.
//
// Uso:
//   ENSAYO: GET /api/revo_catalogo?key=LA_LLAVE&dry=1
//   REAL:   GET /api/revo_catalogo?key=LA_LLAVE
//
// Tabla (ampliada — ejecutar el ALTER si ya se creó la versión anterior):
//   create table if not exists revo_catalogo (
//     item_id bigint primary key,
//     producto text not null,
//     categoria text,
//     categoria_id integer,
//     grupo text,
//     precio numeric(10,2),
//     coste numeric(10,4),
//     activo boolean default true,
//     actualizado_en timestamptz default now()
//   );
//   -- si la tabla ya existía:
//   alter table revo_catalogo add column if not exists categoria_id integer;
//   alter table revo_catalogo add column if not exists coste numeric(10,4);

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return isNaN(n) ? null : n;
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
  const P_ITEMS = isLegacy ? '/api/external/v2/catalog/items' : '/classic/catalog/items';
  const P_CATS  = isLegacy ? '/api/external/v2/catalog/categories' : '/classic/catalog/categories';
  if (isLegacy && !process.env.REVO_TENANT) {
    res.status(500).json({ ok: false, error: 'Token legacy: falta REVO_TENANT' }); return;
  }
  const revoHeaders = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
  if (isLegacy) revoHeaders.tenant = process.env.REVO_TENANT;

  const URL_SB = process.env.SUPABASE_URL;
  const KEY_SB = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!dry && (!URL_SB || !KEY_SB)) { res.status(500).json({ ok: false, error: 'Supabase no configurado' }); return; }

  // Descarga paginada estilo Laravel, con diagnóstico de la primera página
  async function fetchPaginado(path) {
    const filas = [];
    let page = 1, lastPage = 1, diag = null, fallo = null;
    do {
      const r = await fetch(`${BASE}${path}?page=${page}`, { headers: revoHeaders });
      const texto = await r.text();
      let cuerpo = {};
      try { cuerpo = JSON.parse(texto); } catch (_) {}
      if (page === 1) {
        diag = {
          url: `${BASE}${path}?page=1`, http: r.status,
          claves_respuesta: cuerpo && typeof cuerpo === 'object' ? Object.keys(cuerpo).slice(0, 15) : typeof cuerpo,
          primeros_400_chars: texto.slice(0, 400),
        };
      }
      if (!r.ok) { fallo = `HTTP ${r.status}: ${texto.slice(0, 150)}`; break; }
      const lote = Array.isArray(cuerpo) ? cuerpo : Array.isArray(cuerpo.data) ? cuerpo.data : [];
      filas.push(...lote);
      lastPage = cuerpo.last_page || (cuerpo.meta && cuerpo.meta.last_page) || 1;
      page++;
    } while (page <= lastPage && page <= 60);
    return { filas, diag, fallo };
  }

  try {
    // ── 1. Productos y categorías en paralelo ──
    const [items, cats] = await Promise.all([fetchPaginado(P_ITEMS), fetchPaginado(P_CATS)]);
    if (items.fallo) throw new Error('items: ' + items.fallo);

    // ── 2. Mapa id → nombre de categoría (tolerante a dialectos) ──
    const catPorId = {};
    for (const c of cats.filas) {
      if (c && c.id !== undefined) catPorId[c.id] = c.name || c.nom || c.nombre || null;
    }

    // ── 3. Cruzar ──
    const mapeados = [];
    let sinMapear = 0;
    for (const it of items.filas) {
      if (!it || it.id === undefined || it.id === null) { sinMapear++; continue; }
      const nombre = it.name || it.nom || null;
      if (!nombre) { sinMapear++; continue; }
      mapeados.push({
        item_id: it.id,
        producto: String(nombre),
        categoria: catPorId[it.category_id] || null,
        categoria_id: it.category_id ?? null,
        grupo: catPorId[it.super_group_id] || null,
        precio: num(it.price),
        coste: num(it.costPrice),
        activo: it.active !== undefined ? !!it.active : true,
      });
    }
    const conCategoria = mapeados.filter(m => m.categoria).length;

    // ── 4. Ensayo ──
    if (dry) {
      res.status(200).json({
        ok: true, modo: 'ENSAYO (no se ha escrito nada)',
        items_recibidos: items.filas.length,
        categorias_recibidas: cats.filas.length,
        mapeados: mapeados.length, sin_mapear: sinMapear,
        con_categoria: conCategoria,
        muestra_categoria_cruda: cats.filas[0] || null,
        muestra_mapeada: mapeados[0] || null,
        diagnostico_categorias: cats.diag,
        fallo_categorias: cats.fallo || null,
      });
      return;
    }

    // ── 5. Escritura real por lotes ──
    let guardados = 0;
    const errores = [];
    const ahora = new Date().toISOString();
    for (let i = 0; i < mapeados.length; i += 200) {
      const lote = mapeados.slice(i, i + 200).map(m => ({ ...m, actualizado_en: ahora }));
      const r = await fetch(`${URL_SB}/rest/v1/revo_catalogo?on_conflict=item_id`, {
        method: 'POST',
        headers: { ...sbHeaders(KEY_SB), Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(lote),
      });
      if (!r.ok) { errores.push('lote ' + i + ': HTTP ' + r.status); continue; }
      guardados += lote.length;
    }

    console.log(`[revo_catalogo] items=${items.filas.length} cats=${cats.filas.length} guardados=${guardados} con_categoria=${conCategoria} errores=${errores.length}`);
    res.status(200).json({ ok: true, items_recibidos: items.filas.length, categorias_recibidas: cats.filas.length, guardados, con_categoria: conCategoria, errores });
  } catch (e) {
    console.error('[revo_catalogo] fallo:', e.message || e);
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
};
