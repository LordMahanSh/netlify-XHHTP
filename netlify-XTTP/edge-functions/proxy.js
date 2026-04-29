const BACKEND_URL = Deno.env.get("BACKEND_URL");
if (!BACKEND_URL) console.error("BACKEND_URL missing");

const TIMEOUT_MS = 29000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;
const ENABLE_COMPRESSION = true;

const SENSITIVE_HEADERS = [
  "x-backend-url", "x-netlify-edge", "x-nf-request-id",
  "cf-ray", "cf-connecting-ip", "x-forwarded-for"
];

const ERROR_CACHE_CTRL = "no-store, must-revalidate, private";

function errorResponse(message, status = 500, details = null) {
  return new Response(JSON.stringify({
    error: message, status, timestamp: new Date().toISOString(), ...(details && { details })
  }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": ERROR_CACHE_CTRL,
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function cleanHeaders(originalHeaders) {
  const cleaned = new Headers();
  for (const [key, value] of originalHeaders.entries()) {
    const k = key.toLowerCase();
    if (k === "host" || k === "connection" || SENSITIVE_HEADERS.includes(k)) continue;
    if (k === "accept-encoding") {
      cleaned.set(key, "gzip, deflate, br");
      continue;
    }
    cleaned.set(key, value);
  }
  cleaned.set("Connection", "keep-alive");
  cleaned.set("Accept-Encoding", "gzip, deflate, br");
  return cleaned;
}

export default async function proxy(request, context) {
  const url = new URL(request.url);
  const method = request.method;
  const isRetryable = method === "GET" || method === "HEAD";

  if (url.pathname === "/health" || url.pathname === "/_health") {
    return new Response("OK", { status: 200, headers: { "Content-Type": "text/plain" } });
  }

  if (!BACKEND_URL) {
    return errorResponse("BACKEND_URL not configured", 500);
  }

  let upstreamPath = url.pathname.replace(/\/+/g, "/");
  const upstreamUrl = `${BACKEND_URL}${upstreamPath}${url.search}`.replace(/([^:]\/)\/+/g, "$1");
  
  const cleanedHeaders = cleanHeaders(request.headers);
  let lastError = null;

  const maxAttempts = isRetryable ? MAX_RETRIES + 1 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const upstreamResponse = await fetch(upstreamUrl, {
        method,
        headers: cleanedHeaders,
        body: (method !== "GET" && method !== "HEAD") ? request.body : undefined,
        redirect: "follow",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const responseHeaders = new Headers();
      let responseBody = upstreamResponse.body;
      let contentType = upstreamResponse.headers.get("content-type") || "";

      for (const [key, value] of upstreamResponse.headers.entries()) {
        const k = key.toLowerCase();
        if (!SENSITIVE_HEADERS.includes(k) && k !== "set-cookie" && k !== "content-encoding") {
          responseHeaders.set(key, value);
        }
      }
      
      responseHeaders.set("X-Content-Type-Options", "nosniff");
      responseHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
      responseHeaders.set("X-Robots-Tag", "noindex, nofollow");
      responseHeaders.set("X-Accel-Buffering", "no");

      return new Response(responseBody, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders
      });

    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err;
      
      console.warn(`Attempt ${attempt} failed for ${method} ${url.pathname}: ${err.message}`);
      
      const isTemporary = err.name === "AbortError" || 
                          err.message.includes("fetch") ||
                          err.cause?.code === "ECONNRESET" ||
                          err.cause?.code === "ETIMEDOUT";
      
      if (isRetryable && isTemporary && attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
        continue;
      }
      break;
    }
  }

  if (lastError?.name === "AbortError") {
    return errorResponse("Backend timeout after retries", 504, { timeout: TIMEOUT_MS });
  }
  if (lastError?.message?.includes("certificate")) {
    return errorResponse("Backend SSL error", 502, { hint: "Use valid Let's Encrypt certificate" });
  }
  return errorResponse("Backend unreachable after retries", 502, { cause: lastError?.message });
}

export const config = {
  path: "/*",
  excludedPath: ["/favicon.ico", "/robots.txt", "/_health"]
};
