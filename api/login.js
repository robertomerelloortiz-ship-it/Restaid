// /api/login.js — Valida credenciales y soporta modo personal (tablet) para PIN.
const supabaseInit = async () => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.warn('Supabase no configurado, usando DB mock');
    return null;
  }
  try {
    const { createClient } = await import('@supabase/supabase-js');
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  } catch (e) {
    console.error('Error Supabase:', e);
    return null;
  }
};

module.exports = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const mode = url.searchParams.get('mode');
  const action = url.searchParams.get('action');

  // ━━━━━━━━━━━━━━━━━ GET: Diagnóstico o carga de datos (personal mode) ━━━━━━━━━━━━━━━━━
  if (req.method === 'GET') {
    if (mode === 'personal') {
      // Devolver DB para restaid_personal.html (sin auth, libre acceso)
      // En producción, esto debería estar limitado a IPs internas/tablet conocida
      const sb = await supabaseInit();
      let db = { empleados: [], fichajes: [], albaranes: [], proveedores: [] };
      
      if (sb) {
        try {
          const { data: emp } = await sb.from('empleados').select('*');
          const { data: fich } = await sb.from('fichajes').select('*');
          const { data: prov } = await sb.from('proveedores').select('*');
          db = {
            empleados: emp || [],
            fichajes: fich || [],
            albaranes: [],
            proveedores: prov || []
          };
        } catch (e) {
          console.error('Error fetching DB:', e);
        }
      }
      
      res.status(200).json({ ok: true, db });
      return;
    }
    
    // GET diagnostico: informa solo de SI existen las variables
    res.status(200).json({
      ok: false,
      userSet: !!process.env.RESTAID_USER,
      passSet: !!process.env.RESTAID_PASS,
      keySet: !!process.env.ANTHROPIC_API_KEY
    });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false });
    return;
  }

  let body = req.body;
  if (!body || typeof body === 'string') {
    try {
      const raw = await new Promise((resolve, reject) => {
        let d = '';
        req.on('data', c => (d += c));
        req.on('end', () => resolve(d));
        req.on('error', reject);
      });
      body = raw ? JSON.parse(raw) : {};
    } catch (_) { body = {}; }
  }

  // ━━━━━━━━━━━━━━━━━ Personal mode: sync de fichajes y albaranes ━━━━━━━━━━━━━━━━━
  if (mode === 'personal' && action === 'sync') {
    const { db } = body || {};
    if (!db) {
      res.status(400).json({ ok: false, msg: 'No DB' });
      return;
    }
    const sb = await supabaseInit();
    if (sb && db.fichajes && db.fichajes.length > 0) {
      try {
        await sb.from('fichajes').upsert(db.fichajes);
      } catch (e) {
        console.error('Error upserting fichajes:', e);
      }
    }
    res.status(200).json({ ok: true });
    return;
  }

  // ━━━━━━━━━━━━━━━━━ Personal mode: aplicar albarán ━━━━━━━━━━━━━━━━━
  if (mode === 'personal' && action === 'aplicar_albaran') {
    const { albaran, provId, fecha } = body || {};
    if (!albaran || !provId) {
      res.status(400).json({ ok: false, msg: 'Datos incompletos' });
      return;
    }

    const sb = await supabaseInit();
    if (!sb) {
      res.status(500).json({ ok: false, msg: 'DB no disponible' });
      return;
    }

    try {
      // Guardar albarán
      const alb_id = `alb_${Date.now()}`;
      await sb.from('albaranes').insert({
        id: alb_id,
        proveedor_id: provId,
        fecha: fecha || new Date().toISOString().slice(0, 10),
        productos: albaran.productos || []
      });

      // Aplicar stock (mismo logic que restaid_inventario.html)
      if (albaran.productos && albaran.productos.length > 0) {
        for (const prod of albaran.productos) {
          // Obtener receta del producto para calcular conversión
          const { data: receta } = await sb
            .from('recetas')
            .select('*')
            .eq('prod_id', prod.id)
            .single();

          if (receta && receta.ingredientes) {
            // Aplicar cada ingrediente
            for (const ing of receta.ingredientes) {
              const cantBase = (prod.cantidad * (prod.conversion_factor || 1)) * (ing.cantidad || 1);
              
              // Registrar movimiento
              const mov = {
                id: `mov_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                ing_id: ing.id,
                tipo: 'entrada',
                cantidad: cantBase,
                fecha: fecha || new Date().toISOString().slice(0, 10),
                concepto: `Albarán ${prod.nombre}`,
                proveedor_id: provId
              };
              
              await sb.from('movimientos').insert(mov);
            }
          }
        }
      }

      // Devolver DB actualizada
      const { data: emp } = await sb.from('empleados').select('*');
      const { data: fich } = await sb.from('fichajes').select('*');
      const { data: prov } = await sb.from('proveedores').select('*');
      const db = {
        empleados: emp || [],
        fichajes: fich || [],
        albaranes: [],
        proveedores: prov || []
      };

      res.status(200).json({ ok: true, db });
    } catch (e) {
      console.error('Error aplicar albarán:', e);
      res.status(500).json({ ok: false, msg: e.message });
    }
    return;
  }

  // ━━━━━━━━━━━━━━━━━ POST: Login normal (credenciales) ━━━━━━━━━━━━━━━━━
  const { user, pass } = body || {};
  const ok =
    !!process.env.RESTAID_USER &&
    !!process.env.RESTAID_PASS &&
    user === process.env.RESTAID_USER &&
    pass === process.env.RESTAID_PASS;

  res.status(ok ? 200 : 401).json({ ok });
};
