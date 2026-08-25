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
import { startBookIngestRunner } from './services/bookIngestRunner.js';
import { startStoryAudioRunner } from './services/storyAudio.js';
import { startStoryImageRunner } from './services/storyImage.js';

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
  // Started UNCONDITIONALLY in every color (audit §7.2 / Phase 1.3) — this is
  // intentional, not the bug it looks like: the interval's stale-reap half is
  // time-based and must keep running in the idle color too. Only the
  // claim+process half inside each tick is gated on being the active color
  // (config/index.ts's `isRunnerActiveColor`) — see that function's doc for
  // why the gate has to live at the tick level, not here at start-up.
  //
  // The key is OPTIONAL in every environment (dormant-deploy posture): with
  // no key the feature simply reports itself unavailable (503 on enqueue,
  // `ttsConfigured: false` on the status envelope). Warn at boot so a deploy
  // that MEANT to enable TTS is diagnosable immediately.
  if (cfg.ELEVENLABS_API_KEY === undefined) {
    log.warn('story TTS disabled — ELEVENLABS_API_KEY not set');
  }
  const stopStoryAudioRunner = startStoryAudioRunner(log);
  // F-211: the in-server story-illustration job runner — the story-audio
  // runner's exact posture (in-process, unref'd interval, explicit ticks in
  // tests, stale-run reap after a crash). Same dormant-deploy stance: with
  // no OPENAI_API_KEY the feature reports itself unavailable (503 on
  // enqueue, `imageGenConfigured: false` on the status envelope, no
  // batch-at-creation enqueue) and this warn makes a deploy that MEANT to
  // enable illustrations diagnosable at boot.
  if (cfg.OPENAI_API_KEY === undefined) {
    log.warn('story illustrations disabled — OPENAI_API_KEY not set');
  }
  const stopStoryImageRunner = startStoryImageRunner(log);
  // Phase 2.5: the in-server book-ingest runner (the OOM fix's other half —
  // see services/bookIngestRunner.ts's header for the full design). Same
  // posture as the story runners above: started UNCONDITIONALLY in every
  // color (the stale-reap half is time-based and must run everywhere; only
  // claim+process is gated on being the active color, inside the tick
  // itself). No dormant-deploy concept here — book upload has no vendor key,
  // so there's nothing to warn about at boot.
  const stopBookIngestRunner = startBookIngestRunner(log);

  function shutdown(signal: string): void {
    log.info({ signal }, 'shutting down');
    stopStoryAudioRunner();
    stopStoryImageRunner();
    stopBookIngestRunner();
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
