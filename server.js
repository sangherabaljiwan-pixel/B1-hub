/**
 * B1 Hub Proxy Server
 */

const express = require("express");
const fetch   = require("node-fetch");
const cheerio = require("cheerio");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname)));

// ── PROXY ─────────────────────────────
app.get("/proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("Missing ?url=");

  let targetUrl;
  try { targetUrl = new URL(target); }
  catch { return res.status(400).send("Invalid URL"); }

  // 🚫 NEVER proxy YouTube (fixes your issue)
  if (target.includes("youtube.com") || target.includes("youtu.be")) {
    return res.status(403).send("Use direct YouTube embed mode");
  }

  try {
    const upstream = await fetch(target, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });

    const contentType = upstream.headers.get("content-type") || "";

    if (!contentType.includes("text/html")) {
      res.set("Content-Type", contentType);
      upstream.body.pipe(res);
      return;
    }

    const html = await upstream.text();
    const $ = cheerio.load(html);

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;

      if (href.startsWith("javascript:") || href.startsWith("#")) return;

      try {
        const abs = new URL(href, target).href;
        $(el).attr("href", "/proxy?url=" + encodeURIComponent(abs));
      } catch {}
    });

    res.set("Content-Type", "text/html; charset=utf-8");
    res.send($.html());

  } catch (err) {
    res.status(502).send("Proxy error: " + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`B1 Hub running → http://localhost:${PORT}`);
});
