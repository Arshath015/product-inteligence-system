export interface Category {
  id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  sort_order: number;
}

export interface Brand {
  id: string;
  name: string;
  slug: string;
  website_url: string | null;
  description: string | null;
  country: string | null;
  logo_url: string | null;
  status: "active" | "archived";
  created_at: string;
}

export interface Designer {
  id: string;
  name: string;
  slug: string;
  bio: string | null;
  website_url: string | null;
}

export interface ProductImage {
  id: string;
  product_id: string;
  original_url: string | null;
  storage_path: string | null;
  public_url: string | null;
  is_primary: boolean;
  status: "pending" | "stored" | "failed" | "missing";
}

export interface Product {
  id: string;
  name: string;
  slug: string;
  brand_id: string | null;
  designer_id: string | null;
  category_id: string | null;
  description: string | null;
  materials: string | null;
  dimensions: string | null;
  price_text: string | null;
  source_url: string | null;
  canonical_url: string | null;
  source_domain: string | null;
  status: "published" | "draft" | "archived";
  extraction_status: "pending" | "complete" | "partial" | "failed";
  created_at: string;
  updated_at: string;
  brand?: Brand | null;
  designer?: Designer | null;
  category?: Category | null;
  images?: ProductImage[];
}

export interface ExtractedProductData {
  name: string;
  brandName: string | null;
  designerName: string | null;
  categoryHint: string | null;
  description: string | null;
  materials: string | null;
  dimensions: string | null;
  priceText: string | null;
  imageUrls: string[];
  imagesLowConfidence: boolean;
  canonicalUrl: string | null;
  sourceDomain: string | null;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  referenced_product_ids: string[];
  created_at: string;
}
