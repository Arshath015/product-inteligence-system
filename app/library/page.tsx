import { LibraryView } from "@/components/library/LibraryView";

type LibraryPageProps = {
  searchParams: Promise<{ fromProjectId?: string | string[] }>;
};

export default async function LibraryPage({ searchParams }: LibraryPageProps) {
  const { fromProjectId } = await searchParams;
  const returnProjectId =
    typeof fromProjectId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fromProjectId)
      ? fromProjectId
      : null;

  return <LibraryView returnProjectId={returnProjectId} />;
}
