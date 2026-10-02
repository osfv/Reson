export function LibrarySkeleton() {
  return (
    <div className="px-8 pt-4" aria-busy="true" aria-label="Loading library">
      <div className="skeleton h-10 w-48 rounded-md" />
      <div className="skeleton mt-3 h-4 w-24 rounded-md" />
      <div className="mt-8 grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-x-6 gap-y-8">
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i}>
            <div className="skeleton aspect-square w-full rounded-lg" />
            <div className="skeleton mt-3 h-4 w-3/4 rounded-md" />
            <div className="skeleton mt-2 h-3 w-1/2 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}
