import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export default async function handler(req, res) {
  try {
    // Pega ?text= da query string
    const textRaw = req.query?.text;
    const text =
      typeof textRaw === 'string' && textRaw.trim().length > 0
        ? textRaw
        : 'PDF gerado na Vercel 👋';

    // Cria um novo PDF
    const pdfDoc = await PDFDocument.create();

    // Página tamanho A4 (aprox)
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

    // Cabeçalhos HTTP pro navegador entender que é PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="documento.pdf"');

    // Envia o PDF
    res.status(200).send(Buffer.from(pdfBytes));
  } catch (error) {
    console.error('Erro ao gerar PDF:', error);
    res
      .status(500)
      .json({ error: 'Erro ao gerar PDF', details: error.message });
  }
}
