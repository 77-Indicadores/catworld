export default function DashboardLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Carregando…</span>
      <div className="skeleton h-9 w-64" />
      <div className="skeleton h-72" />
    </div>
  );
}
