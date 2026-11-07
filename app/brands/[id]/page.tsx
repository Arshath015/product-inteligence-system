import { BrandDetailView } from "@/components/catalog/BrandDetailView";

export default async function BrandPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BrandDetailView brandId={id} />;
}
