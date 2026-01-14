// /api/download-pdfs-lote.js
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium-min');
const JSZip = require('jszip');
const { setTimeout: sleep } = require('node:timers/promises'); // ✅ substitui waitForTimeout

const DEFAULT_LOGO_URL_OLD =
  'https://images.seeklogo.com/logo-png/62/2/edp-logo-png_seeklogo-621425.png';

// ✅ Seu logo
const DEFAULT_LOGO_URL_NEW =
  'https://captadores.org.br/wp-content/uploads/2024/08/edp.png';

// Cache (serverless “warm” reaproveita)
let _cachedExecutablePath = null;
let _cachedLogoDataUri = null;
let _cachedLogoAt = 0;
const LOGO_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas

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
  _cachedExecutablePath = await chromium.executablePath(getPackUrl());
  return _cachedExecutablePath;
}

// ✅ baixa o logo e transforma em data URI (base64)
async function getLogoDataUri() {
  const now = Date.now();
  if (_cachedLogoDataUri && (now - _cachedLogoAt) < LOGO_TTL_MS) {
    return _cachedLogoDataUri;
  }

  const logoUrl = (process.env.EDP_LOGO_URL || DEFAULT_LOGO_URL_NEW).trim();

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10000);

  const resp = await fetch(logoUrl, {
    signal: controller.signal,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
    }
  }).finally(() => clearTimeout(t));

  if (!resp.ok) throw new Error(`Falha ao baixar logo (${resp.status})`);

  const contentType = resp.headers.get('content-type') || 'image/png';
  const arrayBuffer = await resp.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');

  _cachedLogoDataUri = `data:${contentType};base64,${base64}`;
  _cachedLogoAt = now;

  console.log('Logo baixado ok:', logoUrl, 'base64 chars:', base64.length);
  return _cachedLogoDataUri;
}

// remove dependências externas (evita ficar preso em fontes)
function stripExternalResources(html) {
  let out = html;
  out = out.replace(/<link[^>]+rel=["']preconnect["'][^>]*>\s*/gi, '');
  out = out.replace(/<link[^>]+fonts\.googleapis\.com[^>]*>\s*/gi, '');
  out = out.replace(/<link[^>]+fonts\.gstatic\.com[^>]*>\s*/gi, '');
  return out;
}

// injeta logo no HTML
function injectLogo(html, logoDataUri) {
  if (!logoDataUri) return html;
  let out = html;

  out = out.split(DEFAULT_LOGO_URL_OLD).join(logoDataUri);
  out = out.split(DEFAULT_LOGO_URL_NEW).join(logoDataUri);

  // força em img alt="EDP Logo"
  out = out.replace(/<img\b([^>]*?)\balt\s*=\s*["']EDP Logo["']([^>]*?)>/gi, (m) => {
    const cleaned = m.replace(/\bsrc\s*=\s*["'][^"']*["']/i, '');
    return cleaned.replace('<img', `<img src="${logoDataUri}"`);
  });

  return out;
}

// espera rápida (não trava lote)
async function quickWait(page, maxMs = 1200) {
  const guard = new Promise((resolve) => setTimeout(resolve, maxMs, 'timeout'));
  const work = page.evaluate(async () => {
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

    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch (e) {}
    }

    return 'done';
  });

  return Promise.race([work, guard]).catch(() => 'error');
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
    const { items } = body || {};

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Nenhum item fornecido para geração.' });
    }

    const logoDataUri = await getLogoDataUri();
    const executablePath = await getExecutablePath();

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
      protocolTimeout: 180000
    });

    const zip = new JSZip();

    // ✅ reusa uma página (mais rápido)
    const page = await browser.newPage();
    page.setDefaultTimeout(120000);
    page.setDefaultNavigationTimeout(120000);
    await page.emulateMediaType('print');

    for (const item of items) {
      if (!item || !item.html) continue;

      const baseName =
        typeof item.filename === 'string' && item.filename.trim()
          ? item.filename.trim()
          : 'documento';

      try {
        let html = item.html;

        html = stripExternalResources(html);
        html = injectLogo(html, logoDataUri);

        await page.setContent(html, {
          waitUntil: ['domcontentloaded'],
          timeout: 120000
        });

        // ✅ substitui page.waitForTimeout
        await sleep(120);

        await quickWait(page, 1200);

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
      }
    }

    await page.close();
    await browser.close();
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
