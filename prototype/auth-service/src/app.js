const express = require('express');
const { createHmacAuthMiddleware } = require('./middleware/hmacAuth');
const { createAuthRouter } = require('./routes/authRoutes');

function createApp({ config, cacheService, auditLogger }) {
  const app = express();
  app.disable('x-powered-by');

  app.use(
    express.json({
      limit: '16kb',
      verify: (req, res, buf) => {
        req.rawBody = buf.toString('utf8');
      },
    })
  );

  const hmacAuth = createHmacAuthMiddleware({ config, cacheService });
  const authRouter = createAuthRouter({ config, cacheService, auditLogger, hmacAuth });

  app.use('/', authRouter);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
      return res.status(400).json({
        error: 'INVALID_JSON',
        message: 'Malformed JSON request payload',
      });
    }
    console.error('[ERROR]', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Unexpected authentication service failure',
    });
  });

  return app;
}

module.exports = {
  createApp,
};
