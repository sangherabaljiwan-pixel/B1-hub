const express = require("express");
const fetch   = require("node-fetch");
const cheerio = require("cheerio");
const path    = require("path");

const app = express();

/* =========================================================
   🔥 RENDER FIX (CRITICAL)
========================================================= */
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0"; // REQUIRED for Render

/* =========================================================
   STATIC FILES
========================================================= */
app.use(express.static(path.join(__dirname)));

/* =========================================================
   🔥 CORS FIX (IMPORTANT FOR BROWSER EMBED)
========================================================= */
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  next();
});

app.options("*", (req, res) => res.sendStatus(200));

/* =========================================================
   🔥 HEALTH CHECK (Render needs this sometimes)
========================================================= */
app.get("/health", (req, res) => {
  res.send("OK");
});

/* =========================================================
   🔥 PROXY ROUTE
========================================================= */
app.get("/proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("Missing URL");

  try {
    const response = await fetch(target, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
      }
    });

    const contentType = response.headers.get("content-type");

    res.setHeader("Content-Type", contentType || "text/html");

    // stream or text depending
    if (!contentType?.includes("text/html")) {
      response.body.pipe(res);
      return;
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    $("a[href]").each((_, el) => {
      let href = $(el).attr("href");
      if (!href) return;

      if (!href.startsWith("http")) return;

      $(el).attr("href", `/proxy?url=${encodeURIComponent(href)}`);
    });

    res.send($.html());

  } catch (err) {
    console.error(err);
    res.status(500).send("Proxy error");
  }
});

/* =========================================================
   🔥 START SERVER (RENDER FIX)
========================================================= */
app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
