import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import type { Browser } from "puppeteer-core";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

function cors(extra: Record<string, string> = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-api-key",
    ...extra,
  };
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: cors() });
}

export async function POST(req: Request) {
  const expectedKey = process.env.PDF_RENDER_KEY || "";
  if (expectedKey) {
    const got = req.headers.get("x-api-key") || "";
    if (got !== expectedKey) {
      return new Response("Unauthorized", { status: 401, headers: cors() });
    }
  }

  let payload: any = {};
  try {
    payload = await req.json();
  } catch {
    return new Response("Body JSON inválido", { status: 400, headers: cors() });
  }

  const html = payload?.html;
  const pdfOptions = payload?.pdfOptions || {};

  if (!html || typeof html !== "string") {
    return new Response("Missing html", { status: 400, headers: cors() });
  }

  const c: any = chromium; // resolve tipagem do TS em algumas versões

  let browser: Browser | null = null;

  try {
    browser = await puppeteer.launch({
      args: c.args,
      executablePath: await c.executablePath(),
      headless: c.headless ?? "new",
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(45000);

    await page.setContent(html, { waitUntil: "load" });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      ...pdfOptions,
    });

    // Garante que o body é um tipo aceito pela Response (evita erro de TS)
    const pdfBytes =
      pdfBuffer instanceof Uint8Array ? pdfBuffer : new Uint8Array(pdfBuffer as any);

    return new Response(pdfBytes, {
      status: 200,
      headers: cors({
        "Content-Type": "application/pdf",
        "Cache-Control": "no-store",
        "Content-Disposition": 'attachment; filename="notificacao.pdf"',
      }),
    });
  } catch (e: any) {
    return new Response(String(e?.message || e), { status: 500, headers: cors() });
  } finally {
    try {
      await browser?.close();
    } catch {}
  }
}
