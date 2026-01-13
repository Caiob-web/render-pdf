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

// chromium-min precisa do “pack .tar”. Vamos pegar a versão do próprio package.
function getPackUrl() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  let version = '143.0.4';
  try {
    // pega a versão instalada do chromium-min (mais seguro)
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

// Lê o logo local do repo e vira data URI (sem depender de internet)
function getLogoDataUriFromLocalFile() {
  if (_cachedLogoDataUri) return _cachedLogoDataUri;

  // /var/task/api -> subir um nível e achar /assets
  const logoPath = path.join(process.cwd(), 'assets', 'edp-logo.png');

  if (!fs.existsSync(logoPath)) {
    throw new Error(
      `Logo local não encontrado em ${logoPath}. Crie /assets/edp-logo.png e suba no GitHub.`
    );
  }

  const buf = fs.readFileSync(logoPath);
  const b64 = buf.toString('base64');

  // PNG
  _cachedLogoDataUri = `data:image/png;base64,${b64}`;
  return _cachedLogoDataUri;
}

// Injeta o logo no HTML: troca a URL conhecida + força em <img alt="EDP Logo">
function injectLogo(html, logoDataUri) {
  if (!logoDataUri) return html;

  let out = html;

  // 1) troca a URL padrão (se existir no seu HTML)
  out = out.split(DEFAULT_LOGO_URL).join(logoDataUri);

  // 2) troca qualquer URL seeklogo parecida (caso tenha variação)
  out = out.replace(
    /https?:\/\/images\.seeklogo\.com\/logo-png\/62\/2\/edp-logo-png_seeklogo-621425\.png/gi,
    logoDataUri
  );

  // 3) “cirurgia”: qualquer <img ... alt="EDP Logo" ...> recebe src=logoDataUri
  out = out.replace(/<img\b([^>]*?)\balt\s*=\s*["']EDP Logo["']([^>]*?)>/gi, (m, a, b) => {
    // remove src antigo se existir
    const cleaned = m.replace(/\bsrc\s*=\s*["'][^"']*["']/i, '');
    // injeta src no começo da tag
    return cleaned.replace('<img', `<img src="${logoDataUri}"`);
  });

  return out;
}

// Espera fontes + imagens carregarem antes do PDF
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
          img.addEventListener('error', resolve, { once: true }); // não trava o lote
        });
      })
    );
  });
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

    // ✅ pega logo local e transforma em data URI
    const logoDataUri = getLogoDataUriFromLocalFile();

    const executablePath = await getExecutablePath();

    browser = await puppeteer.launch({
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

      const page = await browser.newPage();

      try {
        // Logs úteis (se algo falhar de novo você vê no log da Vercel)
        page.on('requestfailed', (r) => {
          const url = r.url();
          if (url.includes('seeklogo') || url.includes('.png') || url.includes('.jpg')) {
            console.error('REQUEST FAILED:', url, r.failure()?.errorText);
          }
        });

        await page.emulateMediaType('print');

        // ✅ injeta o logo no HTML (sem mexer no Base44)
        const htmlToRender = injectLogo(item.html, logoDataUri);

        await page.setContent(htmlToRender, {
          waitUntil: ['load', 'domcontentloaded', 'networkidle0'],
          timeout: 60000,
        });

        // ✅ garante que imagens/fontes entraram
        await waitFontsAndImages(page);

        const pdfBuffer = await page.pdf({
          format: 'A4',
          printBackground: true,
          preferCSSPageSize: true,
          margin: { top: '0', right: '0', bottom: '0', left: '0' },
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
      details: error.message,
    });
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
  }
};
