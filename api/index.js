// Vercel serverless entry — re-exports the Express app from server.js.
// On Vercel, process.env.VERCEL is set, so server.js does NOT call app.listen();
// it just exports the app, which Vercel invokes per request.
module.exports = require('../server.js');
