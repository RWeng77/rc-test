const origRequest = require('https').request;
require('https').request = function(url, opts, cb) {
  if (typeof url === 'string' || url instanceof URL) {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('blob.core.windows.net') && opts && opts.method === 'PUT') {
      console.log('[PATCH] Intercepting Azure PUT, adding NEL to blob CT');
      if (opts.headers) {
        const ct = opts.headers['x-ms-blob-content-type'] || opts.headers['Content-Type'];
        if (ct && ct.startsWith('application/json') && !ct.includes('…')) {
          const nelCt = ct + String.fromCharCode(0x85);
          opts.headers['x-ms-blob-content-type'] = nelCt;
          console.log('[PATCH] CT changed to:', JSON.stringify(nelCt), 'hex:', Buffer.from(nelCt).toString('hex'));
        }
      }
    }
  }
  return origRequest.apply(this, arguments);
};
