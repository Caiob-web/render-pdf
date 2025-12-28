const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const JSZip = require('jszip');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Agora espera receber 'items' com html e filename
  const { items } = req.body; 

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Nenhum item fornecido' });
  }

  try {
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const zip = new JSZip();

    for (const item of items) {
      if (!item.html) continue;
      
      const page = await browser.newPage();
      // Define o conteúdo HTML diretamente
      await page.setContent(item.html, { waitUntil: 'networkidle0' });
      const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
      await page.close();
      
      const fname = item.filename.endsWith('.pdf') ? item.filename : `${item.filename}.pdf`;
      zip.file(fname, pdfBuffer);
    }

    await browser.close();

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=notificacoes.zip');
    res.send(zipBuffer);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
