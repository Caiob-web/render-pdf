// /api/download-pdfs-lote.js
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const JSZip = require('jszip');

const LOGO_URL = 'https://images.seeklogo.com/logo-png/62/2/edp-logo-png_seeklogo-621425.png';

// Baixa o logo UMA vez e transforma em data URI (base64)
async function fetchAsDataUri(url) {
  // Node 18+ tem fetch global na Vercel
  const resp = await fetch(url, {
    headers: {
      // alguns hosts ficam chatos com headless/hotlink; esses headers ajudam
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'Referer': 'https://vercel.app/',
    },
  });

  if (!resp.ok) {
    throw new Error(`Falha ao baixar logo (${resp.status})`);
  }

  const contentType = resp.headers.get('content-type') || 'image/png';
  const arrayBuffer = await resp.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  return `data:${contentType};base64,${base64}`;
}

// Espera fontes e imagens carregarem (sem travar o lote se alguma falhar)
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

  let browser;

  try {
    // Espera: { items: [ { html: '...', filename: '...' }, ... ] }
    const { items } = req.body || {};

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Nenhum item fornecido para geração.' });
    }

    // ✅ pega o logo UMA vez e injeta como base64 em todos os HTMLs
    // (isso elimina 100% a chance de "sumir o logo" em lote)
    let logoDataUri = null;
    try {
      logoDataUri = await fetchAsDataUri(LOGO_URL);
    } catch (e) {
      console.error('Não consegui baixar o logo para base64. Vou tentar usar a URL direta mesmo:', e);
      logoDataUri = null;
    }

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
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

        // Ajuda alguns hosts externos a não bloquearem recursos
        await page.setUserAgent(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
        );

        // ✅ Injeção do logo base64 (se conseguiu baixar)
        let htmlToRender = item.html;
        if (logoDataUri) {
          // substitui exatamente a URL do logo que você usa no HTML
          htmlToRender = htmlToRender.split(LOGO_URL).join(logoDataUri);
        }

        // Renderiza o HTML enviado diretamente
        await page.setContent(htmlToRender, { waitUntil: ['load', 'domcontentloaded', 'networkidle0'] });

        // ✅ espera fontes e imagens (garante que o logo foi desenhado antes do pdf)
        await waitFontsAndImages(page);

        const pdfBuffer = await page.pdf({
          format: 'A4',
          printBackground: true,
          preferCSSPageSize: true, // respeita @page do seu HTML
          margin: { top: '0', right: '0', bottom: '0', left: '0' },
        });

        await page.close();

        const fname = baseName.toLowerCase().endsWith('.pdf')
          ? baseName
          : `${baseName}.pdf`;

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
    res.status(500).json({ error: 'Erro interno ao gerar PDFs em lote.' });
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
  }
};
