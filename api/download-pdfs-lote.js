// /api/download-pdfs-lote.js
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium-min');
const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');

const DEFAULT_LOGO_URL =
  'https://images.seeklogo.com/logo-png/62/2/edp-logo-png_seeklogo-621425.png';

// Cache (serverless “warm” reaproveita)
let _cachedExecutablePath = null;
let _cachedLogoDataUri = null;

// -------- Helpers --------
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

// chromium-min precisa do “pack .tar”
function getPackUrl() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  let version = '143.0.4';
  try {
    const pkg = require('@sparticuz/chromium-min/package.json');
    version = pkg.version || version;
  } catch (_) {}

  return (
    process.env.CHROMIUM_PACK_URL ||
    `https://github.com/Sparticuz/chromium/releases/download/v${version}/chromium-v${version}-pack.${arch}.tar`
  );
}

async function getExecutablePath() {
  if (_cachedExecutablePath) return _cachedExecutablePath;
  const packUrl = getPackUrl();
  _cachedExecutablePath = await chromium.executablePath(packUrl);
  return _cachedExecutablePath;
}

// Lê o logo local do repo e vira data URI
function getLogoDataUriFromLocalFile() {
  if (_cachedLogoDataUri) return _cachedLogoDataUri;

  const logoPath = path.join(process.cwd(), 'assets', 'edp-logo.png');

  if (!fs.existsSync(logoPath)) {
    throw new Error(
      `Logo local não encontrado em ${logoPath}. Crie /assets/edp-logo.png e suba no GitHub.`
    );
  }

  const buf = fs.readFileSync(logoPath);
  const b64 = buf.toString('base64');
  _cachedLogoDataUri = `data:image/png;base64,${b64}`;
  return _cachedLogoDataUri;
}

// Injeta o logo no HTML
function injectLogo(html, logoDataUri) {
  if (!logoDataUri) return html;

  let out = html;

  out = out.split(DEFAULT_LOGO_URL).join(logoDataUri);

  out = out.replace(
    /https?:\/\/images\.seeklogo\.com\/logo-png\/62\/2\/edp-logo-png_seeklogo-621425\.png/gi,
    logoDataUri
  );

  out = out.replace(/<img\b([^>]*?)\balt\s*=\s*["']EDP Logo["']([^>]*?)>/gi, (m) => {
    const cleaned = m.replace(/\bsrc\s*=\s*["'][^"']*["']/i, '');
    return cleaned.replace('<img', `<img src="${logoDataUri}"`);
  });

  return out;
}

// Espera fontes + imagens, mas com limite de tempo (pra não travar o lote)
async function waitFontsAndImages(page, maxMs = 8000) {
  // Coloca um “timer” do lado do Node: se estourar, a gente segue
  const guard = new Promise((resolve) => setTimeout(resolve, maxMs, 'timeout'));

  const work = page.evaluate(async () => {
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
          img.addEventListener('error', resolve, { once: true });
        });
      })
    );

    return 'done';
  });

  // Corre a corrida: terminou ou estourou tempo, seguimos
  return Promise.race([work, guard]).catch(() => 'error');
}

// -------- Handler --------
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
    const { items } = body || {};

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Nenhum item fornecido para geração.' });
    }

    const logoDataUri = getLogoDataUriFromLocalFile();
    const executablePath = await getExecutablePath();

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,

      // ✅ aqui é onde resolve seu erro
      protocolTimeout: 180000 // 180s (3min)
    });

    const zip = new JSZip();

    for (const item of items) {
      if (!item || !item.html) continue;

      const baseName =
        typeof item.filename === 'string' && item.filename.trim()
          ? item.filename.trim()
          : 'documento';

      const page = await browser.newPage();

      // timeouts “globais” da página
      page.setDefaultTimeout(120000);
      page.setDefaultNavigationTimeout(120000);

      try {
        await page.emulateMediaType('print');

        // (Opcional) log só de requests que interessam
        page.on('requestfailed', (r) => {
          const url = r.url();
          if (url.includes('fonts.googleapis') || url.includes('gstatic') || url.includes('.png')) {
            console.error('REQUEST FAILED:', url, r.failure()?.errorText);
          }
        });

        const htmlToRender = injectLogo(item.html, logoDataUri);

        await page.setContent(htmlToRender, {
          waitUntil: ['load', 'domcontentloaded', 'networkidle0'],
          timeout: 120000
        });

        // ✅ espera fontes/imagens, mas no máximo 8s (não trava lote)
        await waitFontsAndImages(page, 8000);

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
