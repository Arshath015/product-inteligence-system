import { generateText } from "ai";
import { withGroqRetry } from "@/lib/groq/client";
import { config } from "@/lib/config";

/**
 * Cheap sanity-check used only when the heuristic image ranking couldn't
 * confidently tie a candidate to the product (see `imagesLowConfidence` in
 * extraction.ts). Rejects brand logos/banners/lifestyle-with-wordmark shots
 * before they get saved as a product's primary photo.
 */
export async function isLikelyProductPhoto(bytes: Buffer, contentType: string): Promise<boolean> {
  try {
    const dataUrl = `data:${contentType};base64,${bytes.toString("base64")}`;
    const { text } = await withGroqRetry(
      (model) =>
        generateText({
          model,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Is this a clean product photograph of a single furniture/lighting/decor item (studio or lifestyle shot where the item is clearly the subject)? Answer NO if it is mainly a brand logo, wordmark, text banner, or promotional graphic with large text overlaid. Reply with exactly one word: YES or NO.",
                },
                { type: "file", mediaType: "image", data: dataUrl },
              ],
            },
          ],
        }),
      config.groq.visionModel
    );
    return text.trim().toUpperCase().startsWith("Y");
  } catch {
    // If vision validation itself fails, don't block ingestion on it.
    return true;
  }
}
