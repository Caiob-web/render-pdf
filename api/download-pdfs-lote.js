const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const JSZip = require('jszip');

export default async function handler(req, res) {
  // Permite CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { items } = req.body; // Espera: { items: [{ html: "...", filename: "..." }] }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Nenhum item fornecido para geração.' });
    }

    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const zip = new JSZip();

    for (const item of items) {
      if (!item.html) continue;

      try {
        const page = await browser.newPage();
        // Renderiza o HTML enviado diretamente
        await page.setContent(item.html, { waitUntil: 'networkidle0' });
        
        const pdfBuffer = await page.pdf({ 
          format: 'A4', 
          printBackground: true,
          margin: { top: '0', right: '0', bottom: '0', left: '0' }
        });
        
        await page.close();
        
        // Garante extensão .pdf
        const fname = item.filename.toLowerCase().endsWith('.pdf') ? item.filename : `${item.filename}.pdf`;
        zip.file(fname, pdfBuffer);
      } catch (e) {
        console.error(`Erro ao gerar PDF de ${item.filename}:`, e);
      }
    }

    await browser.close();

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=notificacoes.zip');
    res.send(zipBuffer);

  } catch (error) {
    console.error('Erro geral:', error);
    res.status(500).json({ error: error.message });
  }
}
