const JSZip = require('jszip');

/**
 * Espera receber um POST com JSON:
 * {
 *   "urls": [
 *     "https://meus-pdfs.com/arquivo1.pdf",
 *     "https://meus-pdfs.com/arquivo2.pdf"
 *   ]
 * }
 *
 * Retorna um .zip com todos os PDFs.
 */
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Use método POST' });
  }

  try {
    let body = req.body;

    // Se vier string (às vezes acontece), tenta parsear
    if (!body || typeof body === 'string') {
      try {
        body = JSON.parse(body || '{}');
      } catch (e) {
        return res.status(400).json({ error: 'JSON inválido no corpo da requisição' });
      }
    }

    const urls = Array.isArray(body.urls) ? body.urls : null;

    if (!urls || urls.length === 0) {
      return res.status(400).json({
        error: 'Envie um JSON com {"urls": ["url1.pdf", "url2.pdf", ...]}'
      });
    }

    const zip = new JSZip();

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];

      if (!url || typeof url !== 'string') continue;

      try {
        const response = await fetch(url);

        if (!response.ok) {
          // Se não conseguir baixar, coloca um txt de erro dentro do zip
          zip.file(
            `ERRO_${i + 1}.txt`,
            `Falha ao baixar ${url}: HTTP ${response.status}`
          );
          continue;
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // Tenta extrair um nome do arquivo a partir da URL
        let fileName = url.split('/').pop() || `arquivo-${i + 1}.pdf`;
        if (!fileName.toLowerCase().endsWith('.pdf')) {
          fileName = `${fileName}.pdf`;
        }

        zip.file(fileName, buffer);
      } catch (err) {
        // Em caso de erro, também registra dentro do zip
        zip.file(
          `ERRO_${i + 1}.txt`,
          `Erro ao baixar ${url}: ${err.message}`
        );
      }
    }

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="lote-pdfs.zip"'
    );

    return res.status(200).send(zipBuffer);
  } catch (err) {
    console.error('Erro geral na rota /api/download-pdfs-lote:', err);
    return res.status(500).json({ error: 'Erro interno ao gerar o ZIP' });
  }
};
