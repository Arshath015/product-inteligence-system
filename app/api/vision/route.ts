import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { withGroqRetry } from "@/lib/groq/client";
import { config } from "@/lib/config";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const imageDataUrl = body?.imageDataUrl;
  if (!imageDataUrl || typeof imageDataUrl !== "string") {
    return NextResponse.json({ error: "imageDataUrl is required" }, { status: 400 });
  }
  const question =
    body?.question ||
    "Identify this furniture/interior-design piece. Name the likely product type, style, materials and possible brand or designer if recognizable. Be concise.";

  try {
    const { text } = await withGroqRetry(
      (model) =>
        generateText({
          model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: question },
                { type: "file", mediaType: "image", data: imageDataUrl },
              ],
            },
          ],
        }),
      config.groq.visionModel
    );
    return NextResponse.json({ description: text });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
