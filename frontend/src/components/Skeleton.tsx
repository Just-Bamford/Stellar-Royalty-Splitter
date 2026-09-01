import "./Skeleton.css";

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  circle?: boolean;
  className?: string;
}

export const Skeleton: React.FC<SkeletonProps> = ({
  width,
  height,
  circle,
  className = "",
}) => {
  const style = {
    width,
    height,
    borderRadius: circle ? "50%" : "8px",
  };

  return <div className={`skeleton-loader ${className}`} style={style}></div>;
};

export const DashboardSkeleton = () => {
  return (
    <div className="dashboard-skeleton">
      <div className="kpi-cards-skeleton">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="kpi-card-skeleton">
            <Skeleton width="60%" height="1rem" className="mb-2" />
            <Skeleton width="80%" height="2rem" />
          </div>
        ))}
      </div>
      <div className="charts-skeleton">
        <div className="chart-skeleton">
          <Skeleton width="40%" height="1.5rem" className="mb-4" />
          <Skeleton width="100%" height="300px" />
        </div>
        <div className="chart-skeleton">
          <Skeleton width="40%" height="1.5rem" className="mb-4" />
          <Skeleton width="100%" height="300px" />
        </div>
      </div>
    </div>
  );
};

interface TableSkeletonProps {
  /** Number of placeholder rows to render. */
  rows?: number;
  /** Number of placeholder columns per row. */
  columns?: number;
  /** Accessible label announced to screen readers while loading. */
  label?: string;
}

/**
 * Placeholder for tabular data (e.g. CollaboratorTable) that mirrors the
 * eventual row/column layout so the surrounding page doesn't jump once
 * real data arrives.
 */
export const TableSkeleton: React.FC<TableSkeletonProps> = ({
  rows = 5,
  columns = 3,
  label = "Loading…",
}) => {
  return (
    <div
      className="table-skeleton"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div key={rowIndex} className="table-skeleton-row">
          {Array.from({ length: columns }, (_, colIndex) => (
            <Skeleton
              key={colIndex}
              width={colIndex === 0 ? "40%" : "20%"}
              height="1rem"
            />
          ))}
        </div>
      ))}
    </div>
  );
};

interface ListSkeletonProps {
  /** Number of placeholder list items to render. */
  items?: number;
  /** Accessible label announced to screen readers while loading. */
  label?: string;
}

/**
 * Placeholder for list-style data (e.g. TransactionHistory) — one
 * skeleton line per expected item.
 */
export const ListSkeleton: React.FC<ListSkeletonProps> = ({
  items = 5,
  label = "Loading…",
}) => {
  return (
    <div
      className="list-skeleton"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      {Array.from({ length: items }, (_, i) => (
        <div key={i} className="list-skeleton-item">
          <Skeleton width="70%" height="1rem" className="mb-2" />
          <Skeleton width="40%" height="0.85rem" />
        </div>
      ))}
    </div>
  );
};
