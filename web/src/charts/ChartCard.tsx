import type { ReactNode } from "react";

interface ChartCardProps {
  title: string;
  subtitle?: string;
  /** Shown instead of children when there is not enough data to plot. */
  emptyMessage?: string | null;
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * Card wrapper shared by every insights chart: eyebrow-style title, optional
 * one-line story description, and a consistent empty state.
 */
export default function ChartCard({
  title,
  subtitle,
  emptyMessage,
  actions,
  children,
}: ChartCardProps) {
  return (
    <section className="chart-card" aria-label={title}>
      <div className="chart-card-header">
        <div>
          <h3>{title}</h3>
          {subtitle && <p className="chart-subtitle">{subtitle}</p>}
        </div>
        {actions && <div className="chart-actions">{actions}</div>}
      </div>
      {emptyMessage ? (
        <p className="chart-empty">{emptyMessage}</p>
      ) : (
        children
      )}
    </section>
  );
}
