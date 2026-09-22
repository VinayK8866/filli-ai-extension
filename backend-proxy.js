/**
 * Filli AI Cloud Proxy with Supabase JWT Auth & KV Usage Tracking
 * 
 * Modular worker architecture:
 * - Rate Limiter: ./src/proxy/rateLimiter.js
 * - JWT Verification: ./src/proxy/auth.js
 * - Supabase Integration: ./src/proxy/supabase.js
 * - Webhooks: ./src/proxy/webhooks.js
 */

import { checkRateLimit } from './src/proxy/rateLimiter.js';
import { verifyJWT } from './src/proxy/auth.js';
import { getSupabaseProfile, incrementSupabaseUsage, updateSupabaseProfilePlan } from './src/proxy/supabase.js';
import { verifyLemonSqueezySignature, verifyPaddleSignature, isPaddleIpAllowed } from './src/proxy/webhooks.js';

export default {
  async fetch(request, env, ctx) {
    // 1MB Payload Size Limit Guard
    const contentLength = parseInt(request.headers.get("Content-Length") || "0", 10);
    if (contentLength > 1024 * 1024) {
      return new Response(JSON.stringify({ error: "Payload Too Large. Maximum allowed size is 1MB." }), {
        status: 413,
        headers: { "Content-Type": "application/json" }
      });
    }

    const origin = request.headers.get("Origin") || "";
    
    // Support single or comma-separated list of allowed extension origins to allow dev and prod side-by-side
    const allowedExtensionIds = env.ALLOWED_EXTENSION_ID 
      ? env.ALLOWED_EXTENSION_ID.split(",").map(id => id.trim())
      : [];

    const isAllowed = allowedExtensionIds.includes(origin) || 
      (origin && origin.startsWith("chrome-extension://")) || 
      (origin && origin.endsWith("vinaykondabattula.workers.dev"));
    const allowedOrigin = isAllowed ? origin : "*";

    const url = new URL(request.url);
    const isPostHogRequest = url.pathname.startsWith("/posthog/");

    // Handle PostHog Proxying
    if (isPostHogRequest) {
      const targetPath = url.pathname.replace(/^\/posthog/, "");
      const posthogUrl = new URL(targetPath + url.search, "https://us.i.posthog.com");

      // Handle OPTIONS preflight specifically for PostHog
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": allowedOrigin,
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
          },
        });
      }

      // Rate limiting check for analytics proxy (120 requests/minute per client IP)
      const clientIP = request.headers.get("CF-Connecting-IP") || "anon_ip";
      const phRateLimit = await checkRateLimit(env, `posthog:${clientIP}`, 120, 60);
      if (!phRateLimit.allowed) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded for analytics proxy." }), {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": allowedOrigin,
            "Retry-After": phRateLimit.reset.toString()
          }
        });
      }

      const headers = new Headers(request.headers);
      headers.set("Host", "us.i.posthog.com");
      
      if (clientIP && clientIP !== "anon_ip") {
        headers.set("X-Forwarded-For", clientIP);
        headers.set("X-Real-IP", clientIP);
      }

      try {
        const response = await fetch(posthogUrl.toString(), {
          method: request.method,
          headers: headers,
          body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
          redirect: "follow"
        });

        const responseHeaders = new Headers(response.headers);
        responseHeaders.set("Access-Control-Allow-Origin", allowedOrigin);
        responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        responseHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, X-Anonymous-Client-Id");

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: `PostHog Proxy Error: ${err.message}` }), {
          status: 502,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": allowedOrigin
          }
        });
      }
    }

    const corsHeaders = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Anonymous-Client-Id",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "X-XSS-Protection": "1; mode=block",
      "Referrer-Policy": "strict-origin-when-cross-origin"
    };

    // 1. Handle CORS & Preflight Options
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders,
      });
    }

    // Public Compliance & Pricing Landing Pages — Redirect to canonical site
    if (request.method === "GET" || request.method === "HEAD") {
      const cleanPath = url.pathname.toLowerCase().replace(/\/+$/, "").replace(/\.html$/, "") || "/";

      if (cleanPath === "/" || cleanPath === "/index" || cleanPath === "/pricing") {
        return Response.redirect("https://filli-ai.pages.dev/", 301);
      }
      if (cleanPath === "/terms" || cleanPath === "/terms-of-service") {
        return Response.redirect("https://filli-ai.pages.dev/terms.html", 301);
      }
      if (cleanPath === "/privacy" || cleanPath === "/privacy-policy") {
        return Response.redirect("https://filli-ai.pages.dev/privacy.html", 301);
      }
      if (cleanPath === "/refund" || cleanPath === "/refund-policy" || cleanPath === "/refunds") {
        return Response.redirect("https://filli-ai.pages.dev/refund.html", 301);
      }
      if (cleanPath === "/success" || cleanPath === "/order-complete") {
        return Response.redirect("https://filli-ai.pages.dev/success.html", 301);
      }
      if (cleanPath === "/favicon.ico" || cleanPath === "/favicon.svg") {
        return Response.redirect("https://filli-ai.pages.dev/favicon.svg", 301);
      }
    }

    const isConfigRequest = url.pathname === "/config";

    if (request.method !== "POST" && !(request.method === "GET" && isConfigRequest)) {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Handle dynamic client configuration request (unauthenticated, rate limited to 60 req/min per IP)
    if (isConfigRequest) {
      const clientIP = request.headers.get("CF-Connecting-IP") || "anon_ip";
      const cfgRateLimit = await checkRateLimit(env, `config:${clientIP}`, 60, 60);
      if (!cfgRateLimit.allowed) {
        return new Response(JSON.stringify({ error: "Too many configuration requests." }), {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": cfgRateLimit.reset.toString(),
            ...corsHeaders
          }
        });
      }

      const checkoutUrl = env.LEMON_SQUEEZY_CHECKOUT_URL || "";
      return new Response(JSON.stringify({ checkoutUrl }), {
        headers: {
          "Content-Type": "application/json",
          "X-RateLimit-Limit": cfgRateLimit.limit.toString(),
          "X-RateLimit-Remaining": cfgRateLimit.remaining.toString(),
          ...corsHeaders
        }
      });
    }

    const isUsageRequest = url.pathname === "/usage";
    const isLemonWebhookRequest = url.pathname === "/webhook/lemonsqueezy";
    const isPaddleWebhookRequest = url.pathname === "/webhook/paddle";
    const isPaddleCheckoutRequest = url.pathname === "/checkout/paddle";
    const isPaddlePortalRequest = url.pathname === "/portal/paddle";
    const isPaddleCancelRequest = url.pathname === "/subscription/cancel" || url.pathname === "/subscription/paddle/cancel";

    try {
      // 1. Handle Lemon Squeezy Webhooks (rate limited to 30 req/min per IP)
      if (isLemonWebhookRequest) {
        const clientIP = request.headers.get("CF-Connecting-IP") || "anon_ip";
        const whRateLimit = await checkRateLimit(env, `webhook:lemon:${clientIP}`, 30, 60);
        if (!whRateLimit.allowed) {
          return new Response("Too Many Webhook Requests", {
            status: 429,
            headers: {
              "Retry-After": whRateLimit.reset.toString(),
              ...corsHeaders
            }
          });
        }
        const signatureHeader = request.headers.get("X-Signature");
        const bodyText = await request.text();
        const secret = env.LEMON_SQUEEZY_WEBHOOK_SECRET;

        // Verify signature (fail-closed)
        if (!secret) {
          console.error("LEMON_SQUEEZY_WEBHOOK_SECRET is not configured in the environment.");
          return new Response("Webhook verification failed: Secret configuration missing", { status: 500 });
        }

        const isVerified = await verifyLemonSqueezySignature(bodyText, signatureHeader, secret);
        if (!isVerified) {
          return new Response("Invalid Lemon Squeezy Webhook Signature", { status: 400 });
        }

        const payload = JSON.parse(bodyText);
        const eventName = payload.meta ? payload.meta.event_name : null;
        const eventId = payload.meta && payload.meta.webhook_id ? payload.meta.webhook_id : (payload.data ? payload.data.id : null);
        const customData = payload.meta ? payload.meta.custom_data : null;
        const userId = customData ? (customData.user_id || customData.userId) : null;

        // Webhook Idempotency Guard: prevent duplicate webhook replay processing
        if (eventId && env.USERS_KV) {
          const processedKey = `webhook:processed:lemon:${eventId}`;
          const alreadyProcessed = await env.USERS_KV.get(processedKey);
          if (alreadyProcessed) {
            console.log(`Lemon Squeezy event ${eventId} already processed. Skipping duplicate payload.`);
            return new Response(JSON.stringify({ received: true, status: "already_processed" }), {
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          }
          // Mark event as processed with 7-day TTL
          await env.USERS_KV.put(processedKey, "1", { expirationTtl: 7 * 86400 });
        }

        if (userId) {
          let updatedPlan = "Free Tier";
          let customerPortal = "";
          
          if (eventName === "subscription_created" || eventName === "subscription_updated") {
            const attributes = payload.data ? payload.data.attributes : null;
            const status = attributes ? attributes.status : null;
            customerPortal = attributes && attributes.urls ? attributes.urls.customer_portal : "";

            if (status === "active" || status === "on_trial") {
              updatedPlan = "Pro Plan";
            }
          }

          // 1. Sync to Supabase DB if configured
          await updateSupabaseProfilePlan(userId, updatedPlan, customerPortal, env);

          // 2. Sync to KV (for backward compatibility/speed)
          if (env.USERS_KV) {
            await env.USERS_KV.put(`user:plan:${userId}`, updatedPlan);
            if (customerPortal) {
              await env.USERS_KV.put(`user:customer_portal:${userId}`, customerPortal);
            }
          }
          console.log(`Successfully updated plan for user ${userId} to ${updatedPlan} via Lemon Squeezy webhook`);
        }

        return new Response(JSON.stringify({ received: true }), {
          headers: { 
            "Content-Type": "application/json",
            ...corsHeaders 
          }
        });
      }

      // 1.1. Handle Paddle Billing Webhooks (rate limited to 30 req/min per IP)
      if (isPaddleWebhookRequest) {
        const clientIP = request.headers.get("CF-Connecting-IP") || "anon_ip";
        const whRateLimit = await checkRateLimit(env, `webhook:paddle:${clientIP}`, 30, 60);
        if (!whRateLimit.allowed) {
          return new Response("Too Many Webhook Requests", {
            status: 429,
            headers: {
              "Retry-After": whRateLimit.reset.toString(),
              ...corsHeaders
            }
          });
        }

        // Verify Paddle Live IP Allowlist (log warning if outside CIDR, signature verification below enforces security)
        const isIpPermitted = await isPaddleIpAllowed(clientIP);
        if (!isIpPermitted) {
          console.warn(`[Paddle Webhook] Notice: Webhook request from unlisted IP: ${clientIP}. Proceeding with cryptographic signature check.`);
        }

        const signatureHeader = request.headers.get("Paddle-Signature");
        const bodyText = await request.text();
        const secret = env.PADDLE_WEBHOOK_SECRET;

        // Verify signature (fail-closed)
        if (!secret) {
          console.error("PADDLE_WEBHOOK_SECRET is not configured in the environment.");
          return new Response("Webhook verification failed: Secret configuration missing", { status: 500 });
        }

        const isVerified = await verifyPaddleSignature(bodyText, signatureHeader, secret);
        if (!isVerified) {
          console.warn("[Paddle Webhook] Signature verification failed.");
          return new Response("Invalid Paddle Webhook Signature", { status: 400 });
        }

        let payload;
        try {
          payload = JSON.parse(bodyText);
        } catch {
          return new Response("Invalid JSON payload", { status: 400 });
        }

        const eventType = payload.event_type || "";
        const eventId = payload.event_id || (payload.data ? payload.data.id : null);
        const customData = payload.data ? payload.data.custom_data : null;
        const userId = customData ? (customData.user_id || customData.userId) : null;

        // Webhook Idempotency Guard
        if (eventId && env.USERS_KV) {
          const processedKey = `webhook:processed:paddle:${eventId}`;
          const alreadyProcessed = await env.USERS_KV.get(processedKey);
          if (alreadyProcessed) {
            console.log(`Paddle webhook event ${eventId} already processed. Skipping duplicate.`);
            return new Response(JSON.stringify({ received: true, status: "already_processed" }), {
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          }
          await env.USERS_KV.put(processedKey, "1", { expirationTtl: 7 * 86400 });
        }

        if (userId) {
          let updatedPlan = "Free Tier";
          let customerPortal = "";
          const data = payload.data || {};
          const status = data.status || "";

          // Extract customer management portal URL if available
          if (data.management_urls) {
            const rawUrl = data.management_urls.update_payment_method || data.management_urls.cancel || "";
            customerPortal = rawUrl ? rawUrl.split("?")[0] : "";
          }

          // If transaction.completed has a subscription_id, fetch management URLs from Paddle
          if (!customerPortal && data.subscription_id && env.PADDLE_API_KEY) {
            try {
              const subRes = await fetch(`https://api.paddle.com/subscriptions/${data.subscription_id}`, {
                headers: { "Authorization": `Bearer ${env.PADDLE_API_KEY.trim()}` }
              });
              if (subRes.ok) {
                const subJson = await subRes.json();
                if (subJson.data && subJson.data.management_urls) {
                  const rawUrl = subJson.data.management_urls.update_payment_method || subJson.data.management_urls.cancel || "";
                  customerPortal = rawUrl ? rawUrl.split("?")[0] : "";
                }
              }
            } catch (mgmtErr) {
              console.warn("[Paddle Webhook] Exception fetching subscription management URL:", mgmtErr.message || mgmtErr);
            }
          }

          if (
            eventType === "subscription.canceled" ||
            eventType === "subscription.past_due" ||
            status === "canceled" ||
            status === "past_due"
          ) {
            updatedPlan = "Free Tier";
          } else if (
            eventType === "subscription.activated" ||
            eventType === "subscription.created" ||
            eventType === "subscription.updated" ||
            eventType === "transaction.completed" ||
            eventType === "transaction.paid"
          ) {
            if (status === "active" || status === "trialing" || eventType.startsWith("transaction.")) {
              updatedPlan = "Pro Plan";
            }
          }

          // 1. Sync to Supabase DB if configured
          await updateSupabaseProfilePlan(userId, updatedPlan, customerPortal, env);

          // 2. Sync to KV (for backward compatibility/speed)
          if (env.USERS_KV) {
            await env.USERS_KV.put(`user:plan:${userId}`, updatedPlan);
            if (customerPortal) {
              await env.USERS_KV.put(`user:customer_portal:${userId}`, customerPortal);
            }
          }
          console.log(`Successfully updated plan for user ${userId} to ${updatedPlan} via Paddle webhook (${eventType})`);
        }

        return new Response(JSON.stringify({ received: true }), {
          headers: { 
            "Content-Type": "application/json",
            ...corsHeaders 
          }
        });
      }

      // 2. SaaS Authentication (Supabase JWT Verification)
      const authHeader = request.headers.get("Authorization");
      const clientIP = request.headers.get("CF-Connecting-IP") || "anonymous_ip";
      const rawAnonClientId = request.headers.get("X-Anonymous-Client-Id") || "";
      const validAnonClientId = (typeof rawAnonClientId === "string" && /^anon_[a-zA-Z0-9_-]{16,64}$/.test(rawAnonClientId.trim()))
        ? rawAnonClientId.trim()
        : null;

      let userTier = "anonymous";
      let userId = validAnonClientId || clientIP;
      const anonStorageKey = validAnonClientId ? `anon:id:${validAnonClientId}` : `anon:ip:${clientIP}`;
      let jwtPayload = null;

      if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.split(" ")[1];
        try {
          jwtPayload = await verifyJWT(token, env);
          userTier = "authenticated";
          userId = jwtPayload.sub;
        } catch (jwtErr) {
          return new Response(JSON.stringify({ error: `Authentication Failed: ${jwtErr.message}` }), {
            status: 401,
            headers: {
              "Content-Type": "application/json",
              ...corsHeaders
            }
          });
        }
      } else if (isUsageRequest || isPaddleCheckoutRequest || isPaddlePortalRequest || isPaddleCancelRequest) {
        return new Response(JSON.stringify({ error: "Authentication Required" }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders
          }
        });
      }

      // 2.1. Handle Paddle Checkout Session Creation (Rate limited to 10 req/min per user)
      if (isPaddleCheckoutRequest) {
        const checkoutRateLimit = await checkRateLimit(env, `checkout:paddle:${userId}`, 10, 60);
        if (!checkoutRateLimit.allowed) {
          return new Response(JSON.stringify({ error: "Too many checkout attempts. Please wait a moment." }), {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": checkoutRateLimit.reset.toString(),
              ...corsHeaders
            }
          });
        }

        const paddleApiKey = env.PADDLE_API_KEY ? env.PADDLE_API_KEY.trim() : "";
        const paddlePriceId = env.PADDLE_PRO_PRICE_ID ? env.PADDLE_PRO_PRICE_ID.trim() : "";
        const paddleEnv = (env.PADDLE_ENVIRONMENT || "production").trim();
        const paddleBaseUrl = paddleEnv === "sandbox" ? "https://sandbox-api.paddle.com" : "https://api.paddle.com";

        if (!paddleApiKey || !paddlePriceId) {
          console.error("[Paddle Checkout] Missing PADDLE_API_KEY or PADDLE_PRO_PRICE_ID in worker environment.");
          return new Response(JSON.stringify({ 
            error: "Paddle payment gateway is not configured on the server. Please ensure PADDLE_API_KEY and PADDLE_PRO_PRICE_ID are set in Cloudflare Worker secrets." 
          }), {
            status: 503,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        try {
          let requestBody = null;
          if (request.method === "POST") {
            try {
              requestBody = await request.clone().json();
            } catch {
              requestBody = null;
            }
          }
          const discountId = (requestBody && requestBody.discount_id) ? String(requestBody.discount_id).trim() : null;

          const transactionPayload = {
            items: [
              {
                price_id: paddlePriceId,
                quantity: 1
              }
            ],
            checkout: {
              success_url: "https://filli-ai.pages.dev/success.html"
            },
            ...(discountId ? { discount_id: discountId } : {}),
            custom_data: {
              user_id: String(userId)
            }
          };

          const paddleRes = await fetch(`${paddleBaseUrl}/transactions`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${paddleApiKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(transactionPayload)
          });

          const responseText = await paddleRes.text();
          let paddleData = null;
          try {
            paddleData = JSON.parse(responseText);
          } catch {
            paddleData = null;
          }

          if (!paddleRes.ok || !paddleData) {
            console.error(`[Paddle Checkout] Paddle API returned ${paddleRes.status}:`, responseText);
            let errMsg = "Failed to initiate Paddle checkout transaction.";
            if (paddleData && paddleData.error) {
              const detail = paddleData.error.detail || "";
              const subErrors = Array.isArray(paddleData.error.errors)
                ? paddleData.error.errors.map(e => `${e.field ? e.field + ': ' : ''}${e.message}`).join(', ')
                : "";
              errMsg = subErrors ? `${detail} - ${subErrors}` : (detail || errMsg);
            } else if (responseText) {
              errMsg = `Paddle API Error (${paddleRes.status}): ${responseText.slice(0, 180)}`;
            }
            return new Response(JSON.stringify({ error: errMsg, raw: paddleData }), {
              status: 502,
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          }

          const checkoutUrl = paddleData.data && paddleData.data.checkout ? paddleData.data.checkout.url : null;
          if (!checkoutUrl) {
            console.error("[Paddle Checkout] Paddle transaction returned no checkout.url:", paddleData);
            return new Response(JSON.stringify({ error: "Paddle did not return a checkout URL for this transaction." }), {
              status: 502,
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          }

          return new Response(JSON.stringify({ checkoutUrl }), {
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        } catch (checkoutErr) {
          console.error("[Paddle Checkout] Exception initiating transaction:", checkoutErr);
          return new Response(JSON.stringify({ error: "Internal server error creating checkout session." }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }
      }

      // 2.2. Handle Paddle Customer Portal URL Request (Rate limited to 15 req/min per user)
      if (isPaddlePortalRequest) {
        const portalRateLimit = await checkRateLimit(env, `portal:paddle:${userId}`, 15, 60);
        if (!portalRateLimit.allowed) {
          return new Response(JSON.stringify({ error: "Too many portal requests. Please wait a moment." }), {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": portalRateLimit.reset.toString(),
              ...corsHeaders
            }
          });
        }

        let portalUrl = "";

        // 1. Check USERS_KV first for cached portal URL
        if (env.USERS_KV) {
          portalUrl = await env.USERS_KV.get(`user:customer_portal:${userId}`) || "";
        }

        // 2. Check Supabase DB if not found in KV
        if (!portalUrl) {
          const dbProfile = await getSupabaseProfile(userId, env);
          if (dbProfile && dbProfile.customer_portal_url) {
            portalUrl = dbProfile.customer_portal_url;
          }
        }

        // 3. Fallback: Query Paddle API directly for user's subscriptions / customer
        const paddleApiKey = env.PADDLE_API_KEY ? env.PADDLE_API_KEY.trim() : "";
        if (!portalUrl && paddleApiKey) {
          try {
            const userEmail = (jwtPayload && jwtPayload.email) ? jwtPayload.email.trim().toLowerCase() : "";
            if (userEmail) {
              const custRes = await fetch(`https://api.paddle.com/customers?email=${encodeURIComponent(userEmail)}`, {
                headers: { "Authorization": `Bearer ${paddleApiKey}` }
              });
              if (custRes.ok) {
                const custData = await custRes.json();
                const customer = custData.data && custData.data[0];
                if (customer && customer.id) {
                  const subRes = await fetch(`https://api.paddle.com/subscriptions?customer_id=${customer.id}`, {
                    headers: { "Authorization": `Bearer ${paddleApiKey}` }
                  });
                  if (subRes.ok) {
                    const subData = await subRes.json();
                    const sub = subData.data && subData.data[0];
                    if (sub && sub.management_urls) {
                      const mgmtUrl = sub.management_urls.update_payment_method || sub.management_urls.cancel || "";
                      if (mgmtUrl) {
                        portalUrl = mgmtUrl.split("?")[0];
                      }
                    }
                  }
                }
              }
            }
          } catch (fetchErr) {
            console.error("[Paddle Portal] Exception querying Paddle API:", fetchErr);
          }
        }

        if (portalUrl && portalUrl.includes("/cpl_")) {
          const cleanPortalUrl = portalUrl.split("?")[0];
          if (env.USERS_KV) {
            await env.USERS_KV.put(`user:customer_portal:${userId}`, cleanPortalUrl);
          }
          return new Response(JSON.stringify({ portalUrl: cleanPortalUrl }), {
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        return new Response(JSON.stringify({
          error: "No active billing portal found for this account. If you cancelled or do not have an active subscription, portal access is not required."
        }), {
          status: 404,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      // 2.3. Handle Paddle Subscription Cancellation Request (Rate limited to 5 req/min per user)
      if (isPaddleCancelRequest) {
        const cancelRateLimit = await checkRateLimit(env, `cancel:paddle:${userId}`, 5, 60);
        if (!cancelRateLimit.allowed) {
          return new Response(JSON.stringify({ error: "Too many cancellation attempts. Please wait a moment." }), {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": cancelRateLimit.reset.toString(),
              ...corsHeaders
            }
          });
        }

        const paddleApiKey = env.PADDLE_API_KEY ? env.PADDLE_API_KEY.trim() : "";
        if (!paddleApiKey) {
          return new Response(JSON.stringify({ error: "Paddle API is not configured." }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        try {
          const userEmail = (jwtPayload && jwtPayload.email) ? jwtPayload.email.trim().toLowerCase() : "";
          if (!userEmail) {
            return new Response(JSON.stringify({ error: "User email not found in authentication session." }), {
              status: 400,
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          }

          // 1. Look up customer in Paddle
          const custRes = await fetch(`https://api.paddle.com/customers?email=${encodeURIComponent(userEmail)}`, {
            headers: { "Authorization": `Bearer ${paddleApiKey}` }
          });
          const custData = await custRes.json();
          const customer = custData.data && custData.data[0];
          if (!customer || !customer.id) {
            if (env.USERS_KV) {
              await env.USERS_KV.put(`user:plan:${userId}`, "Free Tier");
            }
            await updateSupabaseProfilePlan(userId, "Free Tier", "", env);
            return new Response(JSON.stringify({ success: true, message: "No active subscription found. Plan set to Free Tier.", plan: "Free Tier" }), {
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          }

          // 2. Find active subscription
          const subRes = await fetch(`https://api.paddle.com/subscriptions?customer_id=${customer.id}&status=active`, {
            headers: { "Authorization": `Bearer ${paddleApiKey}` }
          });
          const subData = await subRes.json();
          const activeSub = subData.data && subData.data[0];

          if (activeSub && activeSub.id) {
            // Cancel subscription immediately on Paddle
            const cancelRes = await fetch(`https://api.paddle.com/subscriptions/${activeSub.id}/cancel`, {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${paddleApiKey}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({ effective_from: "immediately" })
            });
            if (!cancelRes.ok) {
              const cancelErrData = await cancelRes.json().catch(() => ({}));
              const errDetail = cancelErrData.error ? cancelErrData.error.detail : "Paddle cancel failed";
              return new Response(JSON.stringify({ error: errDetail }), {
                status: 502,
                headers: { "Content-Type": "application/json", ...corsHeaders }
              });
            }
          }

          // 3. Immediately reset local plan to Free Tier in KV and Supabase
          if (env.USERS_KV) {
            await env.USERS_KV.put(`user:plan:${userId}`, "Free Tier");
          }
          await updateSupabaseProfilePlan(userId, "Free Tier", "", env);

          return new Response(JSON.stringify({ 
            success: true, 
            message: "Subscription successfully canceled. You are now on the Free Tier.", 
            plan: "Free Tier" 
          }), {
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        } catch (err) {
          console.error("[Paddle Cancel] Exception canceling subscription:", err);
          return new Response(JSON.stringify({ error: "Internal server error canceling subscription." }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }
      }

      // 3. Retrieve plan & usage count
      let userPlan = "Free Tier";
      let usageCount = 0;
      let customerPortalUrl = "";

      if (userTier === "authenticated") {
        const currentMonth = new Date().toISOString().slice(0, 7);
        // Try Supabase DB lookup first
        const dbProfile = await getSupabaseProfile(userId, env);
        if (dbProfile) {
          userPlan = dbProfile.plan || "Free Tier";
          usageCount = parseInt(dbProfile.usage_count || "0", 10);
          customerPortalUrl = dbProfile.customer_portal_url || "";
        }
        
        // Fallback or check KV for plan & portal
        if (env.USERS_KV) {
          if (!dbProfile) {
            userPlan = await env.USERS_KV.get(`user:plan:${userId}`) || "Free Tier";
            usageCount = parseInt(await env.USERS_KV.get(`user:fills:${userId}:${currentMonth}`) || "0", 10);
          }
          if (!customerPortalUrl) {
            customerPortalUrl = await env.USERS_KV.get(`user:customer_portal:${userId}`) || "";
          }
        }
      } else {
        userPlan = "Anonymous Tier";
        if (env.USERS_KV) {
          usageCount = parseInt(await env.USERS_KV.get(anonStorageKey) || "0", 10);
        }
      }

      // 4. Handle Usage Info Request (Rate limited to 30 req/min per user/IP)
      if (isUsageRequest) {
        const usgRateLimit = await checkRateLimit(env, `usage:${userId}`, 30, 60);
        if (!usgRateLimit.allowed) {
          return new Response(JSON.stringify({ error: "Too many usage checks. Please slow down." }), {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": usgRateLimit.reset.toString(),
              ...corsHeaders
            }
          });
        }

        return new Response(JSON.stringify({ usageCount, userPlan, customerPortalUrl }), {
          headers: {
            "Content-Type": "application/json",
            "X-RateLimit-Limit": usgRateLimit.limit.toString(),
            "X-RateLimit-Remaining": usgRateLimit.remaining.toString(),
            ...corsHeaders
          }
        });
      }

      // Safe Body Parsing & Input Validation
      const requestBody = await request.json().catch(() => null);
      if (!requestBody || typeof requestBody !== 'object') {
        return new Response(JSON.stringify({ error: "Invalid JSON request body." }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      const rawPrompt = requestBody.prompt;
      if (rawPrompt === "PING_TEST") {
        return new Response(JSON.stringify({ success: true, message: "pong" }), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      const prompt = typeof rawPrompt === 'string' ? rawPrompt.trim() : '';
      if (!prompt || prompt.length > 32768) {
        return new Response(JSON.stringify({ error: "Invalid prompt. Must be a non-empty string under 32,768 characters." }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      const incrementUsage = requestBody.incrementUsage !== false;
      const rawSchemaFields = Array.isArray(requestBody.schemaFields) ? requestBody.schemaFields : [];
      const schemaFields = rawSchemaFields
        .slice(0, 100)
        .filter(f => f && typeof f.id === 'string' && /^[a-zA-Z0-9_\-]{1,64}$/.test(f.id.trim()))
        .map(f => ({
          id: f.id.trim(),
          type: typeof f.type === 'string' ? f.type.slice(0, 32) : 'text',
          label: typeof f.label === 'string' ? f.label.slice(0, 128) : '',
          placeholder: typeof f.placeholder === 'string' ? f.placeholder.slice(0, 128) : ''
        }));

      // 5. Check Limits & Per-Client Rate Limiting before Generation
      if (incrementUsage !== false) {
        if (userPlan === "Anonymous Tier" && usageCount >= 10) {
          return new Response(
            JSON.stringify({ error: "Anonymous fill limit reached (10/10). Please sign up or log in inside settings to unlock 50 free fills!" }),
            { 
              status: 402, 
              headers: { 
                "Content-Type": "application/json", 
                ...corsHeaders
              } 
            }
          );
        }
        if (userPlan === "Free Tier" && usageCount >= 50) {
          return new Response(
            JSON.stringify({ error: "Monthly fill limit reached (50/50). Upgrade to Pro inside Options!" }),
            { 
              status: 402, 
              headers: { 
                "Content-Type": "application/json", 
                ...corsHeaders
              } 
            }
          );
        }

        // Sliding-window counter rate limit based on plan tier (Pro: 60, Free: 20, Anon: 10 req/min)
        const limitByPlan = {
          "Pro Plan": 60,
          "Free Tier": 20,
          "Anonymous Tier": 10
        };
        const tierLimit = limitByPlan[userPlan] || 10;
        const aiRateLimit = await checkRateLimit(env, `ai:${userId}`, tierLimit, 60);

        if (!aiRateLimit.allowed) {
          return new Response(
            JSON.stringify({ error: `Rate limit exceeded (${tierLimit} requests/minute). Please wait ${aiRateLimit.reset} seconds.` }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "X-RateLimit-Limit": aiRateLimit.limit.toString(),
                "X-RateLimit-Remaining": "0",
                "X-RateLimit-Reset": aiRateLimit.reset.toString(),
                "Retry-After": aiRateLimit.reset.toString(),
                ...corsHeaders
              }
            }
          );
        }
      }

      const API_KEY = env.GEMINI_API_KEY;
      if (!API_KEY) {
        return new Response("Server configuration error: GEMINI_API_KEY secret is missing in environment variables.", { status: 500 });
      }

      // Dynamically construct response schema to enforce structured output constraints
      let responseSchema = null;
      if (schemaFields && Array.isArray(schemaFields) && schemaFields.length > 0) {
        const properties = {};
        const required = [];
        schemaFields.forEach(field => {
          if (field && typeof field.id === 'string') {
            const isBool = field.type === 'checkbox' || field.type === 'radio';
            properties[field.id] = {
              type: isBool ? "BOOLEAN" : "STRING",
              description: `Realistic mock fill data for field '${field.id}' (label: ${field.label || ''}, placeholder: ${field.placeholder || ''})`
            };
            required.push(field.id);
          }
        });
        if (required.length > 0) {
          responseSchema = {
            type: "OBJECT",
            properties: properties,
            required: required
          };
        }
      }

      // Stable production Gemini models with ordered fallback cascade
      const models = [
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-1.5-flash",
        "gemini-1.5-pro"
      ];

      let response = null;
      let lastError = null;

      for (const modelName of models) {
        const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${API_KEY}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 25000); // 25s timeout for large forms

        try {
          console.log(`[Filli AI Proxy] Attempting completion with model: ${modelName}`);
          const res = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              safetySettings: [
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
              ],
              generationConfig: {
                temperature: 0.1, 
                response_mime_type: "application/json",
                ...(responseSchema ? { response_schema: responseSchema } : {})
              }
            }),
            signal: controller.signal
          });

          if (res.ok) {
            response = res;
            break; // Success!
          } else {
            const errText = await res.text();
            const sanitizedErr = errText.slice(0, 200).replace(/[\r\n]+/g, ' ');
            console.warn(`[Filli AI Proxy] Model ${modelName} returned status ${res.status}: ${sanitizedErr}. Attempting failover cascade...`);
            
            let cleanErr = errText;
            try {
              const parsed = JSON.parse(errText);
              if (parsed && parsed.error && parsed.error.message) {
                cleanErr = parsed.error.message;
              }
            } catch (e) {
              // Not JSON, use raw errText
            }
            lastError = new Error(`[${res.status}] ${cleanErr}`);

            // Abort cascade loop for static client/auth errors (400, 401, 403, 404, etc.)
            // Only retry if it is a transient server error (500, 502, 503, 504) or rate limit (429)
            const shouldRetry = res.status === 429 || (res.status >= 500 && res.status <= 599);
            if (!shouldRetry) {
              console.warn(`[Filli AI Proxy] Static error status ${res.status} detected. Aborting cascade.`);
              break; 
            }
          }
        } catch (err) {
          if (err.name === "AbortError") {
            lastError = new Error("Request timed out after 25 seconds.");
            console.warn(`[Filli AI Proxy] Model ${modelName} timed out. Aborting cascade.`);
            break; // Abort cascade immediately on timeout
          } else {
            lastError = err;
          }
          console.warn(`[Filli AI Proxy] Model ${modelName} threw error:`, err.message || err);
        } finally {
          clearTimeout(timeoutId);
        }
      }

      if (!response) {
        console.error("[Filli AI Proxy Error] All model attempts failed:", lastError ? lastError.message : "Unknown failure");
        return new Response(JSON.stringify({ error: "AI generation service is temporarily unavailable. Please try again shortly." }), { 
          status: 502,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders
          }
        });
      }

      const data = await response.json();
      
      let resultText = "{}";
      if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0]) {
        resultText = data.candidates[0].content.parts[0].text;
      }

      // 6. Increment usage after successful API call
      let newUsageCount = usageCount;
      if (incrementUsage !== false) {
        if (userTier === "authenticated") {
          const currentMonth = new Date().toISOString().slice(0, 7);
          // Try atomic increment in Supabase first
          const dbNewCount = await incrementSupabaseUsage(userId, env);
          if (dbNewCount !== null) {
            newUsageCount = dbNewCount;
          } else {
            // Fallback to KV read-modify-write if DB fails (monthly keyed, 60 day TTL)
            newUsageCount = usageCount + 1;
            if (env.USERS_KV) {
              await env.USERS_KV.put(`user:fills:${userId}:${currentMonth}`, newUsageCount.toString(), { expirationTtl: 60 * 86400 });
            }
          }
        } else {
          // Anonymous user: increment in KV with 30-day TTL
          newUsageCount = usageCount + 1;
          if (env.USERS_KV) {
            await env.USERS_KV.put(anonStorageKey, newUsageCount.toString(), { expirationTtl: 30 * 86400 });
          }
        }
      }

      return new Response(JSON.stringify({ 
        text: resultText,
        usageCount: newUsageCount,
        userPlan: userPlan
      }), {
        headers: { 
          "Content-Type": "application/json",
          ...corsHeaders 
        },
      });

    } catch (err) {
      console.error("[Filli AI Proxy Fatal Error]:", err.message || err);
      return new Response(JSON.stringify({ error: "An unexpected server error occurred." }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    }
  },
};
