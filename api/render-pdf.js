import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * Endpoint: /api/render-pdf
 * Exemplo:
 *   https://seu-projeto.vercel.app/api/render-pdf?text=Ola+GP+Caio
 */
export default async function handler(request) {
  // Pega o texto da query string ?text=
  const url = new URL(request.url);
  const text = url.searchParams.get('text') || 'PDF gerado na Vercel 👋';

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

  return new Response(Buffer.from(pdfBytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="documento.pdf"'
    }
  });
}
