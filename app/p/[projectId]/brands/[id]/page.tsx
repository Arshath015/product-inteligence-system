import { BrandDetailView } from "@/components/catalog/BrandDetailView";

export default async function ProjectBrandPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BrandDetailView brandId={id} />;
}
