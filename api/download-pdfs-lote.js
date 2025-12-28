// api/download-pdfs-lote.js
// Converte páginas HTML em PDFs (via Puppeteer) e devolve tudo num ZIP

const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const JSZip = require("jszip");

module.exports = async (req, res) => {
  // ---------- CORS ----------
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const method = (req.method || "GET").toUpperCase();

  try {
    // ---------- 1) Ler URLs da requisição ----------
    let urls = [];

    if (method === "POST") {
      let body = req.body;

      // se o runtime não populou req.body, lê o stream manualmente
      if (!body) {
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString("utf8") || "{}";
        try {
          body = JSON.parse(raw);
        } catch (e) {
          return res
            .status(400)
            .json({ error: "JSON inválido no corpo da requisição." });
        }
      } else if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch (e) {
          return res
            .status(400)
            .json({ error: "JSON inválido no corpo da requisição." });
        }
      }

      urls = Array.isArray(body?.urls) ? body.urls : [];
    } else if (method === "GET") {
      // ?urls=url1,url2,url3 (URL-encoded)
      const q = req.query && req.query.urls;
      if (Array.isArray(q)) {
        urls = q.filter(Boolean);
      } else if (typeof q === "string") {
        urls = q
          .split(",")
          .map((s) => decodeURIComponent(s.trim()))
          .filter(Boolean);
      } else {
        return res.status(400).json({
          error:
            'Envie ?urls=url1,url2,url3 ou use POST com {"urls":["url1","url2"]}.',
        });
      }
    } else {
      res.setHeader("Allow", "GET, POST, OPTIONS");
      return res.status(405).json({ error: "Use GET, POST ou OPTIONS." });
    }

    if (!urls.length) {
      return res.status(400).json({
        error:
          'Lista de URLs vazia. Envie pelo menos uma URL em "urls".',
      });
    }

    // opcional: limitar quantidade para não estourar memória/tempo
    const MAX_URLS = 20;
    if (urls.length > MAX_URLS) {
      urls = urls.slice(0, MAX_URLS);
    }

    // ---------- 2) Sobe o Chromium (Puppeteer) ----------
    const executablePath = await chromium.executablePath();

    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless,
    });

    const zip = new JSZip();

    try {
      // ---------- 3) Gera um PDF por URL ----------
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];

        if (!url || typeof url !== "string") {
          zip.file(
            `ERRO_${i + 1}.txt`,
            `URL inválida na posição ${i + 1}: ${JSON.stringify(url)}`
          );
          continue;
        }

        try {
          const page = await browser.newPage();

          await page.goto(url, {
            waitUntil: "networkidle0",
            timeout: 30000,
          });

          const pdfBuffer = await page.pdf({
            format: "A4",
            printBackground: true,
          });

          await page.close();

          zip.file(`documento_${i + 1}.pdf`, pdfBuffer);
        } catch (err) {
          console.error(`Erro ao renderizar ${url}:`, err);
          zip.file(
            `ERRO_${i + 1}.txt`,
            `Falha ao gerar PDF para ${url}: ${err.message || String(err)}`
          );
        }
      }

      // ---------- 4) Gera o ZIP ----------
      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="notificacoes.zip"'
      );
      return res.status(200).send(zipBuffer);
    } finally {
      await browser.close();
    }
  } catch (err) {
    console.error("Erro geral na rota /api/download-pdfs-lote:", err);
    return res.status(500).json({
      error: "Erro interno ao gerar PDFs",
      details: err.message,
    });
  }
};
