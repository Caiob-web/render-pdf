const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

module.exports = async (req, res) => {
  try {
    // pega o ?text= da query string
    const textRaw = req.query && req.query.text;
    const text =
      typeof textRaw === 'string' && textRaw.trim().length > 0
        ? textRaw
        : 'PDF gerado na Vercel 👋';

    // cria o PDF
    const pdfDoc = await PDFDocument.create();

    // página A4 aproximada
    const page = pdfDoc.addPage([595.28, 841.89]);

    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontSize = 18;

    page.drawText(text, {
      x: 50,
      y: 800,
      size: fontSize,
      font,
      color: rgb(0, 0, 0)
    });

    const pdfBytes = await pdfDoc.save();

    // cabeçalhos HTTP de PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="documento.pdf"');

    // envia o binário
    res.status(200).send(Buffer.from(pdfBytes));
  } catch (error) {
    console.error('Erro ao gerar PDF:', error);
    res
      .status(500)
      .json({ error: 'Erro ao gerar PDF', details: error.message });
  }
};
