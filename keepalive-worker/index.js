export default {
  async scheduled(event, env, ctx) {
    const url = 'https://fortress-options.onrender.com/api/status';
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      console.log('Keep-alive ping: ' + r.status);
    } catch (e) {
      console.log('Keep-alive ping failed: ' + e.message);
    }
  },
  async fetch(request, env, ctx) {
    return new Response('Fortress Keep-Alive Worker running.', { status: 200 });
  }
};
