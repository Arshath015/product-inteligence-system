import { NextRequest, NextResponse } from "next/server";
import PptxGenJS from "pptxgenjs";
import sharp from "sharp";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 120;

type PresentationProduct = {
  id: string;
  name: string;
  source_url: string | null;
  category_name: string | null;
  brand_name: string | null;
  imageUrls: string[];
};

function relatedName(value: unknown): string | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") return null;
  const name = (row as Record<string, unknown>).name;
  return typeof name === "string" ? name : null;
}

function isPublicImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    return !(
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host === "0.0.0.0" ||
      host === "::1" ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
  } catch {
    return false;
  }
}

async function imageData(urls: string[]): Promise<string | null> {
  for (const url of [...new Set(urls.filter(isPublicImageUrl))].slice(0, 2)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6_000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8" },
      });
      if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024) continue;
      const image = sharp(bytes).rotate();
      const metadata = await image.metadata();
      if (!metadata.width || !metadata.height) continue;
      const converted = metadata.hasAlpha
        ? await image.png().toBuffer({ resolveWithObject: true })
        : await image.jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
      const dataType = metadata.hasAlpha ? "image/png" : "image/jpeg";
      return `data:${dataType};base64,${converted.data.toString("base64")}`;
    } catch {
      // Try the next persisted candidate; a missing image does not block the deck.
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  }));
  return results;
}

async function selectedProducts(body: Record<string, unknown>): Promise<PresentationProduct[]> {
  const ids = [...new Set(body.productIds as string[])];
  if (body.source === "library") {
    const { data, error } = await getSupabaseAdmin()
      .from("brand_catalogue_products")
      .select("id, name, source_url, category_name, brand_name, images, primary_image_url, image_public_url")
      .in("id", ids);
    if (error) throw new Error(error.message);
    if (!data || data.length !== ids.length) throw new Error("Some selected Library products are no longer available.");
    return data.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      source_url: row.source_url as string | null,
      category_name: row.category_name as string | null,
      brand_name: row.brand_name as string | null,
      imageUrls: [
        row.image_public_url as string | null,
        row.primary_image_url as string | null,
        ...(Array.isArray(row.images) ? row.images as string[] : []),
      ].filter((url): url is string => Boolean(url)),
    }));
  }

  if (typeof body.projectId !== "string") throw new Error("Select a project catalogue.");
  const supabase = getSupabaseAdmin();
  const { data: refs, error: refsError } = await supabase
    .from("project_products")
    .select("product_id")
    .eq("project_id", body.projectId)
    .in("product_id", ids);
  if (refsError) throw new Error(refsError.message);
  if (!refs || refs.length !== ids.length) throw new Error("Some selected products are not in this project's catalogue.");
  const { data, error } = await supabase
    .from("products")
    .select("id, name, source_url, brand:brands(name), category:categories(name), images:product_images(original_url, public_url, is_primary, status)")
    .in("id", ids);
  if (error) throw new Error(error.message);
  if (!data || data.length !== ids.length) throw new Error("Some selected products are no longer available.");
  return data.map((row) => {
    const brand = relatedName(row.brand);
    const category = relatedName(row.category);
    const images = Array.isArray(row.images) ? row.images as {
      original_url: string | null;
      public_url: string | null;
      is_primary: boolean;
      status: string;
    }[] : [];
    const orderedImages = [
      ...images.filter((image) => image.is_primary && image.status === "stored"),
      ...images.filter((image) => image.status === "stored" && !image.is_primary),
      ...images.filter((image) => image.status !== "stored"),
    ];
    return {
      id: row.id as string,
      name: row.name as string,
      source_url: row.source_url as string | null,
      category_name: category,
      brand_name: brand,
      imageUrls: orderedImages.flatMap((image) => [image.public_url, image.original_url]).filter((url): url is string => Boolean(url)),
    };
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (
    !body ||
    !Array.isArray(body.productIds) ||
    body.productIds.length === 0 ||
    body.productIds.length > 60 ||
    !body.productIds.every((id: unknown) => typeof id === "string") ||
    !["library", "project"].includes(body.source)
  ) {
    return NextResponse.json({ error: "Select between 1 and 60 products to create a presentation." }, { status: 400 });
  }

  try {
    const products = await selectedProducts(body);
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_WIDE";
    pptx.author = "ALTOSSA";
    pptx.subject = "Product selection";
    pptx.title = "ALTOSSA Product Selection";
    pptx.company = "ALTOSSA";
    pptx.theme = { headFontFace: "Aptos Display", bodyFontFace: "Aptos" };

    let missingImages = 0;
    const imageDataByProduct = await mapWithConcurrency(products, 8, async (product) => imageData(product.imageUrls));
    for (const [index, product] of products.entries()) {
      const slide = pptx.addSlide();
      slide.background = { color: "FBFAF7" };
      slide.addText((product.category_name || "PRODUCT").toUpperCase(), {
        x: 0.75, y: 0.35, w: 8.5, h: 0.3,
        fontFace: "Aptos", fontSize: 10, bold: true, charSpacing: 1.5, color: "8B7655",
        margin: 0,
      });
      slide.addShape(pptx.ShapeType.rect, {
        x: 0.75, y: 0.78, w: 11.83, h: 4.65,
        line: { color: "E8E3DA", width: 0.8 },
        fill: { color: "FFFFFF" },
      });

      const data = imageDataByProduct[index];
      if (data) {
        const base64 = data.slice(data.indexOf(",") + 1);
        const imageBuffer = Buffer.from(base64, "base64");
        const meta = await sharp(imageBuffer).metadata();
        const maxW = 11.3;
        const maxH = 4.2;
        const scale = Math.min(maxW / (meta.width ?? maxW), maxH / (meta.height ?? maxH));
        const width = (meta.width ?? maxW) * scale;
        const height = (meta.height ?? maxH) * scale;
        slide.addImage({ data, x: (13.333 - width) / 2, y: 1.0 + (4.2 - height) / 2, w: width, h: height });
      } else {
        missingImages++;
        slide.addText("Product image unavailable", {
          x: 1, y: 2.85, w: 11.3, h: 0.4,
          fontFace: "Aptos", fontSize: 14, color: "9A8F7E", align: "center", margin: 0,
        });
      }

      slide.addText(product.name, {
        x: 0.8, y: 5.68, w: 11.7, h: 0.45,
        fontFace: "Aptos Display", fontSize: 23, bold: true, color: "25221D", margin: 0,
        breakLine: false,
      });
      slide.addText(product.brand_name || "Brand not identified", {
        x: 0.8, y: 6.2, w: 11.7, h: 0.25,
        fontFace: "Aptos", fontSize: 12, color: "6F685D", margin: 0,
      });
      slide.addText(product.source_url || "Original product link unavailable", {
        x: 0.8, y: 6.58, w: 11.7, h: 0.25,
        fontFace: "Aptos", fontSize: 9, color: product.source_url ? "8B7655" : "9A8F7E",
        margin: 0,
        ...(product.source_url ? { hyperlink: { url: product.source_url, tooltip: "Open original product page" } } : {}),
      });
    }

    const output = await pptx.write({ outputType: "uint8array", compression: true });
    const bytes = output instanceof Uint8Array ? output : new Uint8Array(output as ArrayBuffer);
    const bodyBytes = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(bodyBytes).set(bytes);
    const date = new Date().toISOString().slice(0, 10);
    return new NextResponse(bodyBytes, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "Content-Disposition": `attachment; filename="altossa-products-${date}.pptx"`,
        "X-Missing-Images": String(missingImages),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
