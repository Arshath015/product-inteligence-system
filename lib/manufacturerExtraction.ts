import { generateObject } from "ai";
import { z } from "zod";
import { withGroqRetry } from "@/lib/groq/client";
import type { PageSignals } from "@/lib/pageSignals";

const schema = z.object({
  name: z.string().describe("The manufacturer, artisan, workshop, or gallery's own name"),
  location: z.string().nullable().describe("City/region/country if stated anywhere on the page, else null"),
  craft: z
    .string()
    .nullable()
    .describe(
      "Craft, specialisation, or product category — e.g. 'Shipbuilding', 'Ceramics', 'Contemporary design gallery'. Null if not stated."
    ),
  description: z.string().nullable().describe("1-2 sentence description of the entity, else null"),
});

export interface ManufacturerExtraction {
  name: string;
  location: string | null;
  craft: string | null;
  description: string | null;
}

/**
 * Pulls structured directory fields (location, craft/specialisation) for an
 * artisan/manufacturer/gallery/directory page — information that doesn't
 * live in standard meta tags, so unlike product extraction this always
 * needs a model call. Kept to a small schema and only invoked for the
 * minority of bulk-ingest URLs classified as this content type.
 */
export async function extractManufacturerInfo(
  url: string,
  signals: PageSignals | null,
  isDirectory = false
): Promise<ManufacturerExtraction | null> {
  if (!signals) return null;
  const context = [
    `Page title: ${signals.title ?? ""}`,
    `Meta description: ${signals.metaDescription ?? ""}`,
    `Page text: ${signals.textSnippet.slice(0, 3000)}`,
  ].join("\n\n");

  const directoryGuard = isDirectory
    ? " This page is a DIRECTORY or INDEX that lists many different artisans/members/entities — extract the name of the directory or organisation itself (e.g. the trade body, guide, or association running it), never the name of one single entity listed on the page."
    : "";

  try {
    const { object } = await withGroqRetry((model) =>
      generateObject({
        model,
        schema,
        prompt: `Extract directory information about this artisan, manufacturer, workshop, or design gallery from the webpage content below. The source URL is ${url}.${directoryGuard} If a value is not clearly present, use null — never invent a detail.\n\n${context}`,
      })
    );
    return object;
  } catch {
    return null;
  }
}
