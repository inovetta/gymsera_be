/**
 * Walks the Express router stack: every route as { key: "METHOD /api/v1/path/:p", allowed, stage }.
 * `allowed` / `stage` come from validate.strict(...) (null when the route does not use it).
 */
module.exports = function walk(stack, base = '', out = []) {
  for (const layer of stack) {
    if (!layer.route) {
      if (layer.name === 'router' && layer.handle?.stack) {
        let prefix = base;
        if (layer.regexp && !layer.regexp.fast_slash) {
          const clean = layer.regexp.source
            .replace('^\\/', '/').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/')
            .replace(/\^/g, '').replace(/\$/g, '').replace(/\(\?:\(\[\^\\\/]\+\?\)\)/g, ':param');
          prefix = (base + clean).replace(/\/+/g, '/');
        }
        walk(layer.handle.stack, prefix, out);
      }
    } else {
      const r = layer.route;
      let p = (base + (r.path === '/' ? '' : r.path)).replace(/\/+/g, '/');
      if (!p.startsWith('/')) p = '/' + p;
      p = p.replace(/:\w+/g, ':p');
      for (const m of Object.keys(r.methods)) {
        const strict = r.stack.map((s) => s.handle).find((h) => h.__strictAllowed);
        out.push({ key: `${m.toUpperCase()} ${p}`, allowed: strict ? strict.__strictAllowed : null, stage: strict ? strict.__strictStage || 1 : null });
      }
    }
  }
  return out;
};
