// api/download-pdfs-lote.js

let JSZip;

try {
  // tenta carregar a lib; se não estiver instalada, loga erro
  JSZip = require("jszip");
} catch (e) {
  console.error("jszip não encontrado. Rode `npm install jszip`.", e);
}

// helper: baixa um PDF e devolve Buffer (ou cria txt de erro no zip)
async function fetchPdfToBuffer(url, index, zip) {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      zip.file(
        `ERRO_${index + 1}.txt`,
        `Falha ao baixar ${url}: HTTP ${response.status}`
      );
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    console.error(`Erro ao baixar ${url}:`, err);
    zip.file(
      `ERRO_${index + 1}.txt`,
      `Erro ao baixar ${url}: ${err.message}`
    );
    return null;
  }
}

module.exports = async (req, res) => {
  // --------- CORS (libera chamada do Base44 / navegador) ----------
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Preflight (OPTIONS)
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (!JSZip) {
    return res
      .status(500)
      .json({ error: "Dependência jszip não encontrada no servidor." });
  }

  const method = (req.method || "GET").toUpperCase();

  try {
    let urls = [];

    // ----------------- MODO POST: body JSON { urls: [...] } -----------------
    if (method === "POST") {
      let body = req.body;

      // alguns runtimes não populam req.body → ler stream manualmente
      if (!body) {
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString("utf8") || "{}";
        try {
          body = JSON.parse(raw);
        } catch (e) {
          return res
            .status(400)
            .json({ error: "JSON inválido no corpo da requisição." });
        }
      } else if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch (e) {
          return res
            .status(400)
            .json({ error: "JSON inválido no corpo da requisição." });
        }
      }

      urls = Array.isArray(body?.urls) ? body.urls : [];
    }

    // ----------------- MODO GET: ?urls=url1,url2,url3 -----------------
    else if (method === "GET") {
      const q = req.query && req.query.urls;

      if (Array.isArray(q)) {
        urls = q.filter(Boolean);
      } else if (typeof q === "string") {
        urls = q
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      } else {
        return res.status(400).json({
          error:
            'Envie ?urls=url1,url2,url3 ou use POST com {"urls":["url1","url2"]}.'
        });
      }
    }

    // ----------------- OUTROS MÉTODOS: bloqueia -----------------
    else {
      res.setHeader("Allow", "GET, POST, OPTIONS");
      return res
        .status(405)
        .json({ error: "Use métodos GET, POST ou OPTIONS." });
    }

    if (!urls || !urls.length) {
      return res.status(400).json({
        error:
          'Lista de URLs vazia. Envie pelo menos uma URL em "urls".'
      });
    }

    const zip = new JSZip();

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];

      if (!url || typeof url !== "string") {
        zip.file(
          `ERRO_${i + 1}.txt`,
          `URL inválida na posição ${i + 1}: ${JSON.stringify(url)}`
        );
        continue;
      }

      const buffer = await fetchPdfToBuffer(url, i, zip);
      if (!buffer) continue;

      // tenta extrair nome do arquivo
      let fileName = url.split("/").pop() || `arquivo-${i + 1}.pdf`;
      if (!fileName.toLowerCase().endsWith(".pdf")) {
        fileName = `${fileName}.pdf`;
      }

      zip.file(fileName, buffer);
    }

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="lote-pdfs.zip"'
    );

    return res.status(200).send(zipBuffer);
  } catch (err) {
    console.error("Erro geral na rota /api/download-pdfs-lote:", err);
    return res.status(500).json({
      error: "Erro interno ao gerar o ZIP",
      details: err.message
    });
  }
};
