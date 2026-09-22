/**
 * High-Performance In-Memory Rate Limiter for Cloudflare Workers
 * 
 * Avoids burning Cloudflare Workers KV write limits (free tier is capped at 1,000 writes/day).
 * Maintains counters in worker isolate memory with automatic periodic cleanup.
 */

const memoryRateLimitMap = new Map();
let lastPruneTime = Date.now();

export async function checkRateLimit(env, key, limit, windowSeconds = 60) {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;

  // Prune expired entries every 60 seconds or if map grows large to prevent memory leaks
  if (now - lastPruneTime > 60000 || memoryRateLimitMap.size > 2000) {
    for (const [k, entry] of memoryRateLimitMap.entries()) {
      if (now - entry.startTime > windowMs * 2) {
        memoryRateLimitMap.delete(k);
      }
    }
    lastPruneTime = now;
  }

  let entry = memoryRateLimitMap.get(key);
  if (!entry || (now - entry.startTime) >= windowMs) {
    // New window
    entry = { count: 1, startTime: now };
    memoryRateLimitMap.set(key, entry);
    return { 
      allowed: true, 
      remaining: Math.max(0, limit - 1), 
      reset: windowSeconds, 
      limit 
    };
  }

  // Increment within current window
  entry.count += 1;
  const resetSeconds = Math.max(1, Math.ceil((windowMs - (now - entry.startTime)) / 1000));

  if (entry.count > limit) {
    return { 
      allowed: false, 
      remaining: 0, 
      reset: resetSeconds, 
      limit 
    };
  }

  return { 
    allowed: true, 
    remaining: Math.max(0, limit - entry.count), 
    reset: resetSeconds, 
    limit 
  };
}
