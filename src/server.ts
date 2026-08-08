import './load-env.js';

import { buildApp } from './app.js';
import { env } from './env.js';
import { startReaper } from './modules/reports/reaper.js';

const app = await buildApp();

// Recover reports abandoned by a previous process. Started here rather than in
// buildApp so tests driving the app via inject() do not spawn a timer or begin
// generating audits.
const stopReaper = startReaper();

// Railway sends SIGTERM on redeploy. Closing Fastify lets in-flight requests
// finish instead of being cut off mid-response.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    stopReaper();
    void app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ err: error }, 'error during shutdown');
        process.exit(1);
      },
    );
  });
}

try {
  await app.listen({ port: env.PORT, host: env.HOST });
} catch (error) {
  app.log.fatal({ err: error }, 'failed to start server');
  process.exit(1);
}
