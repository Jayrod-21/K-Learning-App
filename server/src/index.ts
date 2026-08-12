/**
 * Server entry point.
 *
 * Validates config, builds the app, binds the port, and wires graceful
 * shutdown. Anything that can fail at startup (bad env, DB unreachable) is
 * surfaced here and crashes the process — supervisor restarts after the
 * fix; "limp along with bad config" is worse than "fail loud".
 */
import { createApp } from './app.js';
import { loadConfig } from './config/index.js';
import { closePool, getPool } from './db/pool.js';
import { getLogger } from './logging.js';
import { buildClaudeProxy, setClaudeProxy } from './services/claudeProxy.js';
import { startStoryAudioRunner } from './services/storyAudio.js';

function main(): void {
  const cfg = loadConfig();
  const log = getLogger();
  // Wire B4 Claude proxy with our pool + logger BEFORE building the app —
  // route handlers resolve the proxy lazily but failing fast at startup is
  // better than 500ing on the first /enrich call.
  setClaudeProxy(buildClaudeProxy({ pool: getPool(), logger: log }));
  const app = createApp();
  const server = app.listen(cfg.PORT, () => {
    log.info({ port: cfg.PORT, env: cfg.NODE_ENV }, 'server listening');
  });
  // F-210: the in-server story-TTS job runner (the km-worker mounts the audio
  // volume read-only, so synthesis must run in THIS process). Started here —
  // never in createApp — so tests drive ticks explicitly; the interval is
  // unref'd and stopped on shutdown. A job caught mid-run by a restart is
  // reaped 'failed' by the stale-run sweep on the next boot.
  //
  // The key is OPTIONAL in every environment (dormant-deploy posture): with
  // no key the feature simply reports itself unavailable (503 on enqueue,
  // `ttsConfigured: false` on the status envelope). Warn at boot so a deploy
  // that MEANT to enable TTS is diagnosable immediately.
  if (cfg.ELEVENLABS_API_KEY === undefined) {
    log.warn('story TTS disabled — ELEVENLABS_API_KEY not set');
  }
  const stopStoryAudioRunner = startStoryAudioRunner(log);

  function shutdown(signal: string): void {
    log.info({ signal }, 'shutting down');
    stopStoryAudioRunner();
    server.close(async () => {
      try {
        await closePool();
      } catch (err) {
        log.error({ err }, 'pool close failed during shutdown');
      } finally {
        process.exit(0);
      }
    });
    // Force-exit after 10s if connections refuse to drain.
    setTimeout(() => process.exit(1), 10_000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'uncaughtException');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log.fatal({ reason }, 'unhandledRejection');
    process.exit(1);
  });
}

if (require.main === module) {
  main();
}
