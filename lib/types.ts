export interface Category {
  id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  sort_order: number;
}

export interface Brand {
  id: string;
  project_id: string;
  name: string;
  slug: string;
  website_url: string | null;
  description: string | null;
  country: string | null;
  logo_url: string | null;
  status: "active" | "archived";
  created_at: string;
  is_owner?: boolean;
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
  project_id: string;
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
  is_owner?: boolean;
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

export interface Inspiration {
  id: string;
  project_id: string;
  platform: "pinterest" | "instagram" | "manufacturer" | "brand" | "other";
  source_url: string;
  canonical_url: string | null;
  title: string | null;
  description: string | null;
  caption: string | null;
  image_original_url: string | null;
  image_storage_path: string | null;
  image_public_url: string | null;
  image_status: "pending" | "stored" | "failed" | "missing";
  tags: string[];
  related_brand_id: string | null;
  related_product_id: string | null;
  status: "active" | "archived";
  created_at: string;
  is_owner?: boolean;
}

export interface Conversation {
  id: string;
  project_id: string;
  title: string | null;
  status: "active" | "archived";
  last_shown_product_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  referenced_product_ids: string[];
  referenced_inspiration_ids: string[];
  created_at: string;
}

export interface Project {
  id: string;
  name: string;
  client_name: string | null;
  description: string | null;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
  stats?: ProjectStats | null;
}

export interface ProjectStats {
  product_count: number;
  brand_count: number;
  inspiration_count: number;
  conversation_count: number;
  last_activity: string | null;
}
