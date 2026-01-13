// render-pdf.js
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");

// (Opcional, se for Next.js API Route)
// Aumenta limite do body pra HTML grande
module.exports.config = {
  api: {
    bodyParser: {
      sizeLimit: "10mb",
    },
  },
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function getHtmlFromRequest(req) {
  // 1) Query string (?html=...)
  if (req.query && typeof req.query.html === "string" && req.query.html.trim()) {
    return req.query.html;
  }

  // 2) Body já parseado (alguns setups)
  if (req.body && typeof req.body.html === "string" && req.body.html.trim()) {
    return req.body.html;
  }

  // 3) Body raw (serverless/express-like)
  const raw = await readBody(req);
  if (!raw || !raw.trim()) return "";

  // Tenta JSON primeiro
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj.html === "string" && obj.html.trim()) return obj.html;
  } catch (_) {}

  // Se não for JSON, assume que o body é o HTML puro
  return raw;
}

module.exports = async (req, res) => {
  let browser = null;

  try {
    const html = await getHtmlFromRequest(req);

    if (!html || typeof html !== "string" || !html.trim()) {
      return res.status(400).json({
        error: "Faltou enviar o HTML",
        dica: 'Envie via POST JSON: { "html": "<!doctype html>..." }',
      });
    }

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    // Importante para logo externo + fontes externas
    await page.setJavaScriptEnabled(true);

    // Carrega o HTML e espera rede "parar"
    await page.setContent(html, {
      waitUntil: ["load", "domcontentloaded", "networkidle0"],
    });

    // ✅ Espera imagens + fontes terminarem de carregar (o ponto do seu logo)
    await page.evaluate(async () => {
      // fontes
      if (document.fonts && document.fonts.ready) {
        try { await document.fonts.ready; } catch (e) {}
      }

      // imagens
      const imgs = Array.from(document.images || []);
      await Promise.all(
        imgs.map((img) => {
          if (img.complete && img.naturalWidth > 0) return Promise.resolve();
          return new Promise((resolve) => {
            img.addEventListener("load", resolve, { once: true });
            img.addEventListener("error", resolve, { once: true }); // não trava lote
          });
        })
      );
    });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true, // respeita @page size/margins do seu CSS
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="documento.pdf"');
    return res.status(200).send(pdfBuffer);
  } catch (error) {
    console.error("Erro ao gerar PDF:", error);
    return res.status(500).json({
      error: "Erro ao gerar PDF",
      details: error.message,
    });
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
  }
};
