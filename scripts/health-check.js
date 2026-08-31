const http = require('http');

const options = {
  hostname: 'localhost',
  port: 3500,
  path: '/api/health',
  headers: { 'x-api-key': 'tcg-admin-test' },
};

http.get(options, (res) => {
  let data = '';
  res.on('data', (chunk) => (data += chunk));
  res.on('end', () => {
    const h = JSON.parse(data);
    console.log('System status:', h.status);
    console.log('Total retailers:', h.retailers.length);
    const healthy = h.retailers.filter((r) => r.healthy);
    const unhealthy = h.retailers.filter((r) => !r.healthy);
    const stale = h.retailers.filter((r) => r.stale);
    const errored = h.retailers.filter((r) => r.consecutiveErrors > 0);
    console.log('Healthy:', healthy.length);
    console.log('Unhealthy:', unhealthy.length);
    console.log('Stale:', stale.length);
    console.log('With errors:', errored.length);
    if (unhealthy.length > 0) {
      console.log('\nUnhealthy retailers:');
      unhealthy.forEach((r) =>
        console.log('  -', r.name, '| errors:', r.consecutiveErrors, '| stale:', r.stale, '| lastError:', r.lastError)
      );
    }
    if (errored.length > 0) {
      console.log('\nRetailers with errors:');
      errored.forEach((r) =>
        console.log('  -', r.name, '| errors:', r.consecutiveErrors, '| lastError:', r.lastError)
      );
    }
  });
});
