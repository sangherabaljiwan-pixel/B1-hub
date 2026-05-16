/**
 * B1 Hub Proxy Server — FIXED v3.1
 */

const express = require("express");
const fetch   = require("node-fetch");
const cheerio = require("cheerio");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Playwright (optional) ─────────────────
let playwright = null;
let browser = null;

async function getPlaywright() {
  if (playwright) return playwright;
  try {
    playwright = require("playwright");
    browser = await playwright.chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
    console.log("Playwright ready");
  } catch {
    playwright = false;
    console.warn("Playwright not installed");
  }
  return playwright;
}

getPlaywright().catch(() => {});

// ── Static files ───────────────────────────
app.use(express.static(path.join(__dirname)));

// ── Safety headers lists ────────────────────
const HOP_BY_HOP = new Set([
  "connection","keep-alive","proxy-authenticate","proxy-authorization",
  "te","trailers","transfer-encoding","upgrade","host"
]);

const STRIP_RESPONSE = new Set([
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "strict-transport-security"
]);

function buildHeaders(req, targetUrl) {
  const headers = {};

  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && k.toLowerCase() !== "cookie") {
      headers[k] = v;
    }
  }

  headers["User-Agent"] =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36";

  headers["Accept"] = req.headers["accept"] || "*/*";
  headers["Accept-Language"] = "en-US,en;q=0.9";
  headers["Referer"] = targetUrl.origin;
  headers["Origin"] = targetUrl.origin;

  if (req.headers.cookie) headers["Cookie"] = req.headers.cookie;

  return headers;
}

function setHeaders(res, upstreamHeaders) {
  if (upstreamHeaders) {
    for (const [k, v] of Object.entries(upstreamHeaders.raw ? upstreamHeaders.raw() : {})) {
      const key = k.toLowerCase();
      if (STRIP_RESPONSE.has(key)) continue;
      if (HOP_BY_HOP.has(key)) continue;

      res.setHeader(k, Array.isArray(v) ? v.join(",") : v);
    }
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function rewrite(html, target) {
  const $ = cheerio.load(html);

  function fix(href) {
    if (!href) return href;
    if (href.startsWith("javascript:") || href.startsWith("#")) return href;
    try {
      const abs = new URL(href, target).href;
      return `/proxy?url=${encodeURIComponent(abs)}`;
    } catch {
      return href;
    }
  }

  $("a[href]").each((_, el) => {
    $(el).attr("href", fix($(el).attr("href")));
  });

  $("form[action]").each((_, el) => {
    $(el).attr("action", fix($(el).attr("action")));
  });

  $("img[src], script[src], iframe[src]").each((_, el) => {
    const src = $(el).attr("src");
    if (src) {
      try {
        $(el).attr("src", new URL(src, target).href);
      } catch {}
    }
  });

  $("head").prepend(`<base href="${target}">`);

  $("meta").remove();

  return $.html();
}

// ── MAIN PROXY ─────────────────────────────
app.get("/proxy", async (req, res) => {
  const target = req.query.url;
  const render = req.query.render === "1";

  if (!target) return res.status(400).send("Missing url");

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return res.status(400).send("Invalid URL");
  }

  // ── Playwright path ──
  if (render) {
    const pw = await getPlaywright();
    if (pw && browser) {
      try {
        const page = await browser.newPage();
        await page.goto(target, { waitUntil: "networkidle" });
        const html = await page.content();
        await page.close();

        setHeaders(res, null);
        res.send(rewrite(html, target));
        return;
      } catch (e) {
        console.log("Playwright failed:", e.message);
      }
    }
  }

  // ── Fetch path ──
  try {
    const r = await fetch(target, {
      headers: buildHeaders(req, targetUrl),
      redirect: "follow",
    });

    const type = r.headers.get("content-type") || "";
    setHeaders(res, r.headers);

    if (!type.includes("text/html")) {
      res.setHeader("Content-Type", type);
      r.body.pipe(res);
      return;
    }

    const html = await r.text();
    res.setHeader("Content-Type", "text/html");
    res.send(rewrite(html, target));

  } catch (e) {
    res.status(500).send("Proxy error: " + e.message);
  }
});

app.options("/proxy", (_, res) => {
  res.sendStatus(204);
});

// IMPORTANT FIX FOR RENDER
app.listen(PORT, "0.0.0.0", () => {
  console.log("B1 Hub running on port", PORT);
});
