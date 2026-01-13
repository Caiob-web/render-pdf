// /api/download-pdfs-lote.js
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium-min');
const JSZip = require('jszip');

// 🔒 URL padrão do logo que você usa no HTML hoje
const DEFAULT_LOGO_URL =
  'https://images.seeklogo.com/logo-png/62/2/edp-logo-png_seeklogo-621425.png';

// cache simples (em serverless pode reaproveitar em invocações quentes)
let cachedLogoDataUri = null;
let cachedLogoAt = 0;
const LOGO_TTL_MS = 6 * 60 * 60 * 1000; // 6h

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
    return {};
  }
}

async function fetchAsDataUri(url) {
  const now = Date.now();
  if (cachedLogoDataUri && (now - cachedLogoAt) < LOGO_TTL_MS) {
    return cachedLogoDataUri;
  }

  const resp = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'Referer': 'https://vercel.app/'
    }
  });

  if (!resp.ok) throw new Error(`Falha ao baixar logo (${resp.status})`);

  const contentType = resp.headers.get('content-type') || 'image/png';
  const arrayBuffer = await resp.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');

  cachedLogoDataUri = `data:${contentType};base64,${base64}`;
  cachedLogoAt = now;
  return cachedLogoDataUri;
}

async function waitFontsAndImages(page) {
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch (e) {}
    }

    const imgs = Array.from(document.images || []);
    await Promise.all(
      imgs.map((img) => {
        if (img.complete && img.naturalWidth > 0) return Promise.resolve();
        return new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        });
      })
    );
  });
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let browser;

  try {
    const body = await getJsonBody(req);
    const { items, logoUrl } = body || {};

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Nenhum item fornecido para geração.' });
    }

    // ✅ tenta logo base64 (para nunca falhar no render)
    let logoDataUri = null;
    const logoToFetch = (typeof logoUrl === 'string' && logoUrl.trim()) ? logoUrl.trim() : DEFAULT_LOGO_URL;

    try {
      logoDataUri = await fetchAsDataUri(logoToFetch);
    } catch (e) {
      console.error('Falha ao baixar logo p/ base64. Vou seguir sem injeção base64:', e);
      logoDataUri = null;
    }

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true
    });

    const zip = new JSZip();

    for (const item of items) {
      if (!item || !item.html) continue;

      const baseName =
        typeof item.filename === 'string' && item.filename.trim()
          ? item.filename.trim()
          : 'documento';

      const page = await browser.newPage();

      try {
        await page.setUserAgent(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
        );

        let htmlToRender = item.html;

        // ✅ injeta base64 no lugar da URL (blindado)
        if (logoDataUri) {
          htmlToRender = htmlToRender.split(DEFAULT_LOGO_URL).join(logoDataUri);
          // se por acaso o HTML veio com outra URL (logoUrl), troca também
          if (logoToFetch !== DEFAULT_LOGO_URL) {
            htmlToRender = htmlToRender.split(logoToFetch).join(logoDataUri);
          }
        }

        await page.setContent(htmlToRender, { waitUntil: ['load', 'domcontentloaded', 'networkidle0'] });
        await waitFontsAndImages(page);

        const pdfBuffer = await page.pdf({
          format: 'A4',
          printBackground: true,
          preferCSSPageSize: true,
          margin: { top: '0', right: '0', bottom: '0', left: '0' }
        });

        const fname = baseName.toLowerCase().endsWith('.pdf') ? baseName : `${baseName}.pdf`;
        zip.file(fname, pdfBuffer);
      } catch (e) {
        console.error(`Erro ao gerar PDF de ${baseName}:`, e);
      } finally {
        try { await page.close(); } catch (e) {}
      }
    }

    try { await browser.close(); } catch (e) {}
    browser = null;

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=notificacoes.zip');
    return res.status(200).send(zipBuffer);
  } catch (error) {
    console.error('Erro geral na geração do lote:', error);
    return res.status(500).json({
      error: 'Erro interno ao gerar PDFs em lote.',
      details: error.message
    });
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
  }
};
