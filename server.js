/**
 * B1 Hub Proxy Server — v3.0
 * ──────────────────────────
 * Install:  npm install
 *           npm install playwright   ← for JS rendering (optional)
 *           npx playwright install chromium
 * Run:      node server.js
 * Visit:    http://localhost:3000
 *
 * Query params:
 *   ?url=https://example.com          — standard proxy (streamed)
 *   ?url=https://example.com&render=1 — Playwright full-JS render
 */

const express = require("express");
const fetch   = require("node-fetch");
const cheerio = require("cheerio");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Playwright (optional — graceful no-op if not installed) ─────────────────
let playwright = null;
let browser    = null;

async function getPlaywright() {
  if (playwright) return playwright;
  try {
    playwright = require("playwright");
    browser    = await playwright.chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
    console.log("  ✦ Playwright chromium ready");
  } catch {
    playwright = false;
    console.warn("  ⚠  Playwright not installed — render=1 will fall back to fetch");
  }
  return playwright;
}

// Pre-warm on startup (non-blocking)
getPlaywright().catch(() => {});

// ── Static files ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));

// ── Shared helpers ──────────────────────────────────────────────────────────

/** Headers that must never be forwarded to the upstream (hop-by-hop + host) */
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade", "host",
]);

/** Headers that must never be sent to the client (security / framing blocks) */
const STRIP_RESPONSE = new Set([
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "x-content-type-options",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "strict-transport-security",
]);

/** Build the upstream request headers from the browser's request */
function buildUpstreamHeaders(req, targetUrl) {
  const headers = {};

  // Forward safe headers from the browser
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && k.toLowerCase() !== "cookie") {
      headers[k] = v;
    }
  }

  // Always spoof a real browser UA
  headers["User-Agent"]      = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  headers["Accept"]          = req.headers["accept"] || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
  headers["Accept-Language"] = req.headers["accept-language"] || "en-US,en;q=0.9";
  headers["Referer"]         = targetUrl.origin + "/";
  headers["Origin"]          = targetUrl.origin;

  // Cookie passthrough — forward cookies the browser has stored for this proxy
  if (req.headers["cookie"]) {
    headers["Cookie"] = req.headers["cookie"];
  }

  return headers;
}

/** Apply permissive CORS + remove frame-blocking response headers */
function setPermissiveHeaders(res, upstreamHeaders) {
  if (upstreamHeaders) {
    for (const [k, v] of Object.entries(upstreamHeaders.raw ? upstreamHeaders.raw() : {})) {
      const lk = k.toLowerCase();
      if (STRIP_RESPONSE.has(lk)) continue;
      if (HOP_BY_HOP.has(lk))    continue;

      // Relay Set-Cookie verbatim (cookie passthrough)
      if (lk === "set-cookie") {
        res.setHeader("Set-Cookie", v);
        continue;
      }
      // Forward content-type, cache-control, etag, etc.
      res.setHeader(k, v.join ? v.join(", ") : v);
    }
  }

  res.removeHeader("X-Frame-Options");
  res.removeHeader("Content-Security-Policy");
  res.removeHeader("Content-Security-Policy-Report-Only");
  res.removeHeader("X-Content-Type-Options");
  res.removeHeader("Cross-Origin-Opener-Policy");
  res.removeHeader("Cross-Origin-Embedder-Policy");
  res.removeHeader("Cross-Origin-Resource-Policy");

  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
}

/** Rewrite URLs inside HTML so everything is routed through our proxy */
function rewriteHtml(html, target) {
  const targetUrl = new URL(target);
  const $         = cheerio.load(html);

  function rewrite(href) {
    if (!href) return href;
    href = href.trim();
    if (
      href.startsWith("javascript:") || href.startsWith("#") ||
      href.startsWith("data:")       || href.startsWith("blob:")
    ) return href;
    try {
      const abs = new URL(href, target).href;
      return `/proxy?url=${encodeURIComponent(abs)}`;
    } catch { return href; }
  }

  $("a[href]").each((_, el)      => $(el).attr("href",   rewrite($(el).attr("href"))));
  $("form[action]").each((_, el) => $(el).attr("action", rewrite($(el).attr("action"))));

  $("img[src], script[src], source[src], video[src], audio[src], iframe[src]").each((_, el) => {
    const src = $(el).attr("src");
    if (src) try { $(el).attr("src", new URL(src, target).href); } catch {}
  });

  $("link[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (href) try { $(el).attr("href", new URL(href, target).href); } catch {}
  });

  // srcset
  $("[srcset]").each((_, el) => {
    const srcset = $(el).attr("srcset") || "";
    const rewritten = srcset.replace(/(\S+)(\s+[\d.]+[wx])?/g, (match, url, desc) => {
      try { return new URL(url, target).href + (desc || ""); }
      catch { return match; }
    });
    $(el).attr("srcset", rewritten);
  });

  // data-src (lazy load)
  $("[data-src]").each((_, el) => {
    const src = $(el).attr("data-src");
    if (src) try { $(el).attr("data-src", new URL(src, target).href); } catch {}
  });

  // Base tag
  $("head").prepend(`<base href="${targetUrl.origin}/">`);

  // Strip meta frame-blockers
  $('meta[http-equiv="Content-Security-Policy"]').remove();
  $('meta[http-equiv="X-Frame-Options"]').remove();
  $('meta[http-equiv="Cross-Origin-Opener-Policy"]').remove();
  $('meta[http-equiv="Cross-Origin-Embedder-Policy"]').remove();

  return $.html();
}

// ── /proxy — main route ─────────────────────────────────────────────────────
app.get("/proxy", async (req, res) => {
  const target  = req.query.url;
  const usePlay = req.query.render === "1";

  if (!target) return res.status(400).send("Missing ?url=");

  let targetUrl;
  try { targetUrl = new URL(target); }
  catch { return res.status(400).send("Invalid URL"); }

  // ── PLAYWRIGHT path ───────────────────────────────────────────────────────
  if (usePlay) {
    const pw = await getPlaywright();

    if (pw && browser) {
      let page;
      try {
        const context = await browser.newContext({
          userAgent:   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          extraHTTPHeaders: {
            "Accept-Language": "en-US,en;q=0.9",
            ...(req.headers["cookie"] ? { Cookie: req.headers["cookie"] } : {}),
          },
          ignoreHTTPSErrors: true,
        });

        page = await context.newPage();

        // Intercept Set-Cookie from any navigation response
        const cookies = [];
        page.on("response", async r => {
          const sc = r.headers()["set-cookie"];
          if (sc) cookies.push(...sc.split("\n"));
        });

        await page.goto(target, { waitUntil: "networkidle", timeout: 30000 });

        // Forward cookies to browser
        if (cookies.length) res.setHeader("Set-Cookie", cookies);

        const html = await page.content();
        await context.close();

        setPermissiveHeaders(res, null);
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(rewriteHtml(html, target));
        return;

      } catch (err) {
        if (page) try { await page.context().close(); } catch {}
        console.error("Playwright error:", err.message);
        // Fall through to fetch-based proxy on Playwright failure
      }
    }
    // Playwright not available / failed — fall through silently
  }

  // ── STREAMING FETCH path ─────────────────────────────────────────────────
  try {
    const upstreamRes = await fetch(target, {
      headers:  buildUpstreamHeaders(req, targetUrl),
      redirect: "follow",
      compress: true, // node-fetch handles decompression automatically
    });

    const contentType = upstreamRes.headers.get("content-type") || "";
    const status      = upstreamRes.status;

    setPermissiveHeaders(res, upstreamRes.headers);

    // ── Non-HTML: stream raw bytes straight to client ─────────────────────
    if (!contentType.includes("text/html")) {
      res.status(status);
      res.setHeader("Content-Type", contentType);

      // Stream without buffering
      upstreamRes.body.pipe(res);
      upstreamRes.body.on("error", err => {
        console.error("Stream error:", err.message);
        if (!res.headersSent) res.status(502).end();
        else res.end();
      });
      return;
    }

    // ── HTML: buffer → rewrite → send ────────────────────────────────────
    // (Must buffer HTML to rewrite URLs; everything else is streamed)
    const html = await upstreamRes.text();

    res.status(status);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(rewriteHtml(html, target));

  } catch (err) {
    console.error("Proxy error:", err.message);
    if (!res.headersSent) {
      res.status(502).send(`
        <html><body style="background:#07090f;color:#e8ecf5;font-family:monospace;padding:40px">
          <h2 style="color:#ff4057">502 — Proxy Error</h2>
          <p style="color:#5a6a99;margin-top:10px">${err.message}</p>
        </body></html>
      `);
    }
  }
});

// ── OPTIONS pre-flight (CORS) ───────────────────────────────────────────────
app.options("/proxy", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
  res.sendStatus(204);
});

// ── POST support (form submissions through proxy) ───────────────────────────
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.post("/proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("Missing ?url=");

  let targetUrl;
  try { targetUrl = new URL(target); }
  catch { return res.status(400).send("Invalid URL"); }

  try {
    const body = req.is("application/json")
      ? JSON.stringify(req.body)
      : new URLSearchParams(req.body).toString();

    const upstreamRes = await fetch(target, {
      method:  "POST",
      headers: {
        ...buildUpstreamHeaders(req, targetUrl),
        "Content-Type":   req.headers["content-type"] || "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body).toString(),
      },
      body,
      redirect: "follow",
    });

    const contentType = upstreamRes.headers.get("content-type") || "";
    setPermissiveHeaders(res, upstreamRes.headers);
    res.status(upstreamRes.status);

    if (!contentType.includes("text/html")) {
      res.setHeader("Content-Type", contentType);
      upstreamRes.body.pipe(res);
      return;
    }

    const html = await upstreamRes.text();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(rewriteHtml(html, target));

  } catch (err) {
    console.error("POST proxy error:", err.message);
    if (!res.headersSent) res.status(502).send(err.message);
  }
});

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ✦ B1 Hub running → http://localhost:${PORT}`);
  console.log(`  ✦ Proxy: GET/POST /proxy?url=<target>`);
  console.log(`  ✦ Playwright render: add &render=1\n`);
});
