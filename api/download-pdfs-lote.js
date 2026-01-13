// /api/download-pdfs-lote.js
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium-min');
const JSZip = require('jszip');

let _cachedExecutablePath = null;

function getSparticuzPackUrl() {
  // Vercel normalmente roda em x64. Se você estiver em ARM, ele ajusta.
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';

  // Alinhe com a versão que você instalar no package.json:
  // @sparticuz/chromium-min 143.0.4 -> pack v143.0.4
  const version = process.env.CHROMIUM_VERSION || '143.0.4';

  // Você pode sobrescrever por ENV se quiser hospedar o pack em outro lugar
  // (S3, etc) para ficar ainda mais rápido/estável.
  return (
    process.env.CHROMIUM_PACK_URL ||
    `https://github.com/Sparticuz/chromium/releases/download/v${version}/chromium-v${version}-pack.${arch}.tar`
  );
}

async function getExecutablePath() {
  if (_cachedExecutablePath) return _cachedExecutablePath;

  // chromium-min NÃO inclui binários; você precisa apontar para um pack. :contentReference[oaicite:2]{index=2}
  const packUrl = getSparticuzPackUrl();
  _cachedExecutablePath = await chromium.executablePath(packUrl);
  return _cachedExecutablePath;
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Espera: { items: [ { html: '...', filename: '...' }, ... ] }
    const { items } = req.body || {};

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Nenhum item fornecido para geração.' });
    }

    const executablePath = await getExecutablePath();

    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const zip = new JSZip();

    for (const item of items) {
      if (!item || !item.html) continue;

      const baseName =
        typeof item.filename === 'string' && item.filename.trim()
          ? item.filename.trim()
          : 'documento';

      try {
        const page = await browser.newPage();

        // Garante que regras @media print sejam aplicadas
        await page.emulateMediaType('print');

        // Renderiza o HTML enviado diretamente
        await page.setContent(item.html, {
          waitUntil: ['load', 'networkidle0'],
          timeout: 60000,
        });

        // Se houver fontes web, espera carregar (sem quebrar se não existir)
        try {
          await page.evaluate(async () => {
            if (document.fonts && document.fonts.ready) {
              await document.fonts.ready;
            }
          });
        } catch (_) {}

        const pdfBuffer = await page.pdf({
          format: 'A4',
          printBackground: true,
          preferCSSPageSize: true,
          margin: { top: '0', right: '0', bottom: '0', left: '0' },
        });

        await page.close();

        const fname = baseName.toLowerCase().endsWith('.pdf') ? baseName : `${baseName}.pdf`;
        zip.file(fname, pdfBuffer);
      } catch (e) {
        console.error(`Erro ao gerar PDF de ${baseName}:`, e);
      }
    }

    await browser.close();

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=notificacoes.zip');
    res.status(200).send(zipBuffer);
  } catch (error) {
    console.error('Erro geral na geração do lote:', error);
    res.status(500).json({ error: 'Erro interno ao gerar PDFs em lote.', details: error.message });
  }
};
