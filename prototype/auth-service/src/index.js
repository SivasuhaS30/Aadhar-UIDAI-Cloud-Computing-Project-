require('dotenv').config();

const { loadConfig } = require('./config');
const { createCacheService } = require('./services/cacheService');
const { createAuditLogger } = require('./services/auditLogger');
const { createApp } = require('./app');

const config = loadConfig();
const cacheService = createCacheService(config);
const auditLogger = createAuditLogger({ enabled: true });

const app = createApp({ config, cacheService, auditLogger });

const server = app.listen(config.port, () => {
  console.log(
    `[BOOT] Aadhaar Auth Service listening on port ${config.port} | region=${config.region} | instance=${config.instanceId} | cache=${cacheService.driverName}`
  );
});

async function shutdown(signal) {
  console.log(`[SHUTDOWN] Received ${signal}, closing server...`);
  server.close(async () => {
    try {
      await cacheService.close();
    } finally {
      process.exit(0);
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
