// /api/render-pdf.js
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium-min');

// Lê body (caso req.body venha vazio)
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function getJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const raw = await readBody(req);
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __raw: raw };
  }
}

async function waitFontsAndImages(page) {
  await page.evaluate(async () => {
    // Fontes
    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch (e) {}
    }

    // Imagens
    const imgs = Array.from(document.images || []);
    await Promise.all(
      imgs.map((img) => {
        if (img.complete && img.naturalWidth > 0) return Promise.resolve();
        return new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true }); // não trava
        });
      })
    );
  });
}

module.exports = async (req, res) => {
  // CORS (se quiser chamar direto do Base44 também)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  let browser = null;

  try {
    const body = await getJsonBody(req);

    const htmlFromQuery =
      req.query && typeof req.query.html === 'string' ? req.query.html : '';

    const html =
      (typeof body.html === 'string' && body.html.trim()) ? body.html :
      (typeof htmlFromQuery === 'string' && htmlFromQuery.trim()) ? htmlFromQuery :
      (typeof body.__raw === 'string' && body.__raw.trim()) ? body.__raw :
      '';

    if (!html) {
      return res.status(400).json({
        error: 'Faltou enviar o HTML',
        dica: 'Envie POST JSON { "html": "<!doctype html>..." }'
      });
    }

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true
    });

    const page = await browser.newPage();
    await page.setJavaScriptEnabled(true);

    await page.setContent(html, { waitUntil: ['load', 'domcontentloaded', 'networkidle0'] });

    await waitFontsAndImages(page);

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true
    });

    await page.close();
    await browser.close();
    browser = null;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="documento.pdf"');
    return res.status(200).send(pdfBuffer);
  } catch (error) {
    console.error('Erro ao gerar PDF:', error);
    return res.status(500).json({ error: 'Erro ao gerar PDF', details: error.message });
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
  }
};
