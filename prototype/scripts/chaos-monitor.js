const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  try {
    require(path.resolve(__dirname, '../auth-service/node_modules/dotenv')).config({ path: envPath });
  } catch {
    // Ignore if dotenv is unavailable outside auth-service
  }
}

const { loadConfig } = require('../auth-service/src/config');
const { appendVerhoeffDigit } = require('../auth-service/src/utils/verhoeff');
const { computeHmac } = require('../auth-service/src/utils/crypto');

function parseCliArgs(argv) {
  const opts = {
    url: 'http://127.0.0.1',
    intervalMs: 500,
    durationSec: 60,
    maxTicks: 0,
    healthOnly: false,
    hmacSecret: '',
    outDir: path.resolve(__dirname, '../results'),
    tag: 'live',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url' && argv[i + 1]) opts.url = argv[++i];
    else if (arg === '--interval-ms' && argv[i + 1]) opts.intervalMs = Number(argv[++i]) || 500;
    else if (arg === '--duration-sec' && argv[i + 1]) opts.durationSec = Number(argv[++i]);
    else if (arg === '--hmac-secret' && argv[i + 1]) opts.hmacSecret = argv[++i];
    else if (arg === '--out-dir' && argv[i + 1]) opts.outDir = path.resolve(argv[++i]);
    else if (arg === '--tag' && argv[i + 1]) opts.tag = argv[++i];
    else if (arg === '--health-only') opts.healthOnly = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node scripts/chaos-monitor.js --url http://<ALB_OR_LB_URL> [--interval-ms 500] [--duration-sec 60] [--hmac-secret <SECRET>] [--health-only] [--tag aws-alb]'
      );
      process.exit(0);
    }
  }

  opts.url = opts.url.replace(/\/+$/, '');
  return opts;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[idx].toFixed(2));
}

async function signedPost(baseUrl, secret, endpoint, payload, timeoutMs = 4000) {
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = computeHmac(secret, `${timestamp}.${rawBody}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-timestamp': timestamp,
        'x-signature': signature,
      },
      body: rawBody,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { ok: res.ok, status: res.status, body: json };
  } finally {
    clearTimeout(timer);
  }
}

async function probeTick({ seq, baseUrl, hmacSecret, healthOnly, quiet }) {
  const isoTime = new Date().toISOString();
  const sample = {
    seq,
    timestamp: isoTime,
    healthStatus: 0,
    healthRegion: 'unreachable',
    healthInstanceId: '-',
    redisRole: '-',
    promoted: false,
    healthLatencyMs: 0,
    authStatusCode: null,
    authResult: null,
    authRegion: null,
    authLatencyMs: null,
    error: null,
  };

  // 1. Probe /health
  const t0 = performance.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    clearTimeout(timer);
    sample.healthLatencyMs = Number((performance.now() - t0).toFixed(2));
    sample.healthStatus = res.status;
    const data = await res.json();
    sample.healthRegion = data.region || 'unknown';
    sample.healthInstanceId = data.instanceId || '-';
    if (data.replication) {
      sample.redisRole = data.replication.role || '-';
      sample.promoted = Boolean(data.replication.promoted);
    }
  } catch (err) {
    sample.healthLatencyMs = Number((performance.now() - t0).toFixed(2));
    sample.error = err.message;
  }

  // 2. Optionally probe full signed OTP Generate -> Verify transaction
  if (!healthOnly) {
    const uid = appendVerhoeffDigit(String(91000000000 + (seq % 900000000)));
    const tAuth0 = performance.now();
    try {
      const gen = await signedPost(baseUrl, hmacSecret, '/auth/otp/generate', {
        uid,
        nonce: `chaos-${seq}-${Date.now()}`,
      });
      if (!gen.ok || !gen.body.demoOtp) {
        sample.authStatusCode = gen.status;
        sample.authResult = gen.body.error || 'GEN_FAILED';
      } else {
        const ver = await signedPost(baseUrl, hmacSecret, '/auth/verify', {
          uid,
          txnId: gen.body.txnId,
          otp: gen.body.demoOtp,
          nonce: `chaos-${seq}-v-${Date.now()}`,
        });
        sample.authStatusCode = ver.status;
        sample.authResult = ver.body.authStatus || ver.body.error || 'UNKNOWN';
        sample.authRegion = ver.body.region || null;
      }
    } catch (err) {
      sample.authStatusCode = 0;
      sample.authResult = `ERR:${err.message}`;
    }
    sample.authLatencyMs = Number((performance.now() - tAuth0).toFixed(2));
  }

  if (!quiet) {
    const seqPad = String(seq).padStart(3, '0');
    const promoTag = sample.promoted ? ' [PROMOTED]' : '';
    const authPart = healthOnly
      ? ''
      : ` | auth=${sample.authStatusCode} result=${sample.authResult} zone=${sample.authRegion || '-'} (${sample.authLatencyMs}ms)`;
    console.log(
      `[${isoTime}] #${seqPad} | health=${sample.healthStatus} zone=${sample.healthRegion} role=${sample.redisRole}${promoTag} (${sample.healthLatencyMs}ms)${authPart}${sample.error ? ` | err=${sample.error}` : ''}`
    );
  }

  return sample;
}

async function runChaosMonitor(userOptions = {}) {
  const cfg = loadConfig();
  const opts = {
    url: 'http://127.0.0.1',
    intervalMs: 500,
    durationSec: 60,
    maxTicks: 0,
    healthOnly: false,
    hmacSecret: cfg.hmacSecret,
    outDir: path.resolve(__dirname, '../results'),
    tag: 'live',
    quiet: false,
    onTick: null,
    ...userOptions,
  };
  if (!opts.hmacSecret) opts.hmacSecret = cfg.hmacSecret;
  opts.url = opts.url.replace(/\/+$/, '');

  const samples = [];
  let stopRequested = false;
  let seq = 0;

  const sigintHandler = () => {
    stopRequested = true;
  };
  process.once('SIGINT', sigintHandler);

  if (!opts.quiet) {
    console.log(`=== Aadhaar Multi-AZ Chaos/Failover Monitor ===`);
    console.log(`Target URL : ${opts.url}`);
    console.log(`Interval   : ${opts.intervalMs} ms | Duration: ${opts.durationSec || 'until Ctrl+C'} s | Mode: ${opts.healthOnly ? 'health-only' : 'full-signed-auth'}\n`);
  }

  const endAt = opts.durationSec > 0 ? Date.now() + opts.durationSec * 1000 : Infinity;
  const maxTicks = opts.maxTicks > 0 ? opts.maxTicks : Infinity;

  try {
    while (!stopRequested && Date.now() < endAt && seq < maxTicks) {
      seq += 1;
      const sample = await probeTick({
        seq,
        baseUrl: opts.url,
        hmacSecret: opts.hmacSecret,
        healthOnly: opts.healthOnly,
        quiet: opts.quiet,
      });
      samples.push(sample);
      if (typeof opts.onTick === 'function') {
        await opts.onTick(sample, samples);
      }
      if (!stopRequested && Date.now() < endAt && seq < maxTicks) {
        await new Promise((r) => setTimeout(r, opts.intervalMs));
      }
    }
  } finally {
    process.removeListener('SIGINT', sigintHandler);
  }

  const healthOk = samples.filter((s) => s.healthStatus === 200);
  const authOk = samples.filter((s) => s.authStatusCode === 200 && s.authResult === 'Y');
  const zoneCounts = {};
  for (const s of healthOk) {
    zoneCounts[s.healthRegion] = (zoneCounts[s.healthRegion] || 0) + 1;
  }

  const healthLatencies = healthOk.map((s) => s.healthLatencyMs).sort((a, b) => a - b);
  const authLatencies = authOk.map((s) => s.authLatencyMs).filter((x) => x !== null).sort((a, b) => a - b);

  const summary = {
    executedAt: new Date().toISOString(),
    targetUrl: opts.url,
    tag: opts.tag,
    totalTicks: samples.length,
    healthSuccessCount: healthOk.length,
    healthFailureCount: samples.length - healthOk.length,
    healthAvailabilityPct: samples.length
      ? Number(((healthOk.length / samples.length) * 100).toFixed(2))
      : 0,
    authSuccessCount: opts.healthOnly ? null : authOk.length,
    authFailureCount: opts.healthOnly ? null : samples.length - authOk.length,
    zoneDistribution: zoneCounts,
    promotionObserved: samples.some((s) => s.promoted),
    healthLatencyMs: {
      p50: percentile(healthLatencies, 50),
      p95: percentile(healthLatencies, 95),
      p99: percentile(healthLatencies, 99),
    },
    authLatencyMs: opts.healthOnly
      ? null
      : {
          p50: percentile(authLatencies, 50),
          p95: percentile(authLatencies, 95),
          p99: percentile(authLatencies, 99),
        },
    samples,
  };

  if (opts.outDir) {
    fs.mkdirSync(opts.outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const jsonPath = path.join(opts.outDir, `chaos-report-${opts.tag}-${stamp}.json`);
    const csvPath = path.join(opts.outDir, `chaos-timeline-${opts.tag}-${stamp}.csv`);

    fs.writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

    const csvHeader =
      'seq,timestamp,healthStatus,healthRegion,healthInstanceId,redisRole,promoted,healthLatencyMs,authStatusCode,authResult,authRegion,authLatencyMs,error';
    const csvRows = samples.map((s) =>
      [
        s.seq,
        s.timestamp,
        s.healthStatus,
        s.healthRegion,
        s.healthInstanceId,
        s.redisRole,
        s.promoted,
        s.healthLatencyMs,
        s.authStatusCode ?? '',
        s.authResult ?? '',
        s.authRegion ?? '',
        s.authLatencyMs ?? '',
        (s.error || '').replace(/,/g, ';'),
      ].join(',')
    );
    fs.writeFileSync(csvPath, `${[csvHeader, ...csvRows].join('\n')}\n`, 'utf8');
    summary.outputFiles = { jsonPath, csvPath };

    if (!opts.quiet) {
      console.log('\n=== Chaos/Failover Summary ===');
      console.log(JSON.stringify({ ...summary, samples: `[${samples.length} samples]` }, null, 2));
    }
  }

  return summary;
}

if (require.main === module) {
  const args = parseCliArgs(process.argv.slice(2));
  runChaosMonitor(args).catch((err) => {
    console.error('Chaos monitor failed:', err);
    process.exit(1);
  });
}

module.exports = {
  runChaosMonitor,
};
