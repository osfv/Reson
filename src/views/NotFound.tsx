import { PillButton } from "../components/Buttons";
import { useUi } from "../store/ui";

export function NotFound({ what }: { what: string }) {
  const navigate = useUi((s) => s.navigate);
  return (
    <div className="px-8 pt-16">
      <h1 className="text-2xl font-semibold tracking-tight">This {what} is no longer in your library</h1>
      <p className="mt-2 text-sm text-ink-muted">It may have been removed, or its files were moved.</p>
      <PillButton className="mt-6" onClick={() => navigate({ name: "albums" })}>
        Back to albums
      </PillButton>
    </div>
  );
}
