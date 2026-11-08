// Vercel serverless entry. Every route (rewritten from vercel.json) is
// handled by this Express app; @vercel/node treats the default export as the
// request handler. Module init is top-level, so it runs once per cold start.
import app from '../src/server.js';

export default app;
