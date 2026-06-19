// /api/login.js — Valida usuario y contraseña contra variables de entorno.
// Nada de esto viaja al navegador hasta que el usuario lo acierta.
module.exports = async (req, res) => {
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

  const { user, pass } = body || {};
  const ok =
    !!process.env.RESTAID_USER &&
    !!process.env.RESTAID_PASS &&
    user === process.env.RESTAID_USER &&
    pass === process.env.RESTAID_PASS;

  res.status(ok ? 200 : 401).json({ ok });
};
