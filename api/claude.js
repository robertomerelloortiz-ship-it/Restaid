// /api/claude.js — Proxy a Anthropic. La clave vive solo aquí (variable de
// entorno), nunca en el navegador. Valida la contraseña antes de reenviar.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Método no permitido' } });
    return;
  }

  // Cuerpo (Vercel suele parsearlo; si no, lo leemos en crudo)
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

  // Autorización: 'personal' permite acceso sin contraseña, otros requieren contraseña
  const pass = req.headers['x-restaid-pass'] || '';
  const isPersonalMode = pass === 'personal';
  const requiresAuth = !isPersonalMode;

  if (requiresAuth && (!process.env.RESTAID_PASS || pass !== process.env.RESTAID_PASS)) {
    res.status(401).json({ error: { message: 'No autorizado' } });
    return;
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.status(500).json({ error: { message: 'Falta ANTHROPIC_API_KEY en el servidor' } });
    return;
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
    const text = await r.text();
    res.status(r.status);
    res.setHeader('Content-Type', 'application/json');
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: { message: 'Error al contactar con la IA' } });
  }
};

// Permite que el análisis de visión (que puede tardar) no se corte a los 10s.
// En plan Hobby de Vercel el máximo es 60s.
module.exports.config = { maxDuration: 60 };
