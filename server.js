/**
 * B1 Hub Proxy Server
 * -------------------
 * Install:  npm install
 * Run:      node server.js
 * Visit:    http://localhost:3000
 */

const express = require("express");
const fetch   = require("node-fetch");
const cheerio = require("cheerio");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 3000; // Render sets PORT automatically

// ── Serve index.html + static files ────────────────────────────────────────
app.use(express.static(path.join(__dirname)));

// ── /proxy?url=https://example.com ─────────────────────────────────────────
app.get("/proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("Missing ?url=");

  let targetUrl;
  try { targetUrl = new URL(target); }
  catch { return res.status(400).send("Invalid URL"); }

  try {
    const upstream = await fetch(target, {
      headers: {
        "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });

    const contentType = upstream.headers.get("content-type") || "";

    // Non-HTML (images, CSS, JS, fonts) — pass through raw
    if (!contentType.includes("text/html")) {
      res.set("Content-Type", contentType);
      upstream.body.pipe(res);
      return;
    }

    // HTML — rewrite URLs so everything stays on our proxy
    const html = await upstream.text();
    const $    = cheerio.load(html);
    const base = targetUrl.origin;

    function rewrite(href) {
      if (!href) return href;
      href = href.trim();
      if (href.startsWith("javascript:") || href.startsWith("#") ||
          href.startsWith("data:") || href.startsWith("blob:")) return href;
      try {
        const abs = new URL(href, target).href;
        return `/proxy?url=${encodeURIComponent(abs)}`;
      } catch { return href; }
    }

    $("a[href]").each((_, el)      => $(el).attr("href",   rewrite($(el).attr("href"))));
    $("form[action]").each((_, el) => $(el).attr("action", rewrite($(el).attr("action"))));

    $("img[src], script[src], source[src]").each((_, el) => {
      const src = $(el).attr("src");
      if (src) try { $(el).attr("src", new URL(src, target).href); } catch {}
    });

    $("link[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (href) try { $(el).attr("href", new URL(href, target).href); } catch {}
    });

    // Base tag so relative JS paths resolve correctly
    $("head").prepend(`<base href="${base}/">`);

    // Strip frame-blocking meta tags
    $('meta[http-equiv="Content-Security-Policy"]').remove();
    $('meta[http-equiv="X-Frame-Options"]').remove();

    // Strip blocking response headers
    res.removeHeader("X-Frame-Options");
    res.removeHeader("Content-Security-Policy");
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send($.html());

  } catch (err) {
    console.error("Proxy error:", err.message);
    res.status(502).send(`
      <html><body style="background:#07090f;color:#e8ecf5;font-family:monospace;padding:40px">
        <h2 style="color:#ff4057">502 — Proxy Error</h2>
        <p style="color:#5a6a99;margin-top:10px">${err.message}</p>
      </body></html>
    `);
  }
});

app.listen(PORT, () => {
  console.log(`\n  ✦ B1 Hub running → http://localhost:${PORT}\n`);
});
