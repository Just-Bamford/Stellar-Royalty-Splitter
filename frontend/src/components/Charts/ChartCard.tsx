import React, { useCallback, useRef } from 'react';

export interface ChartCardProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  exportFileName?: string;
  exportName?: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

function download(dataUrl: string, filename: string) {
  const a = document.createElement('a');
  a.download = filename;
  a.href = dataUrl;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export function ChartCard({
  title,
  subtitle,
  actions,
  children,
  className,
  exportFileName,
  exportName,
  loading,
  error,
  onRetry,
}: ChartCardProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const effectiveExportName = exportFileName || exportName;

  const serializeSvg = useCallback((): string | null => {
    const node = containerRef.current?.querySelector('svg');
    if (!node) return null;
    const clone = node.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const width = node.getAttribute('width') ?? String(node.clientWidth);
    const height = node.getAttribute('height') ?? String(node.clientHeight);
    if (!clone.getAttribute('width')) clone.setAttribute('width', width);
    if (!clone.getAttribute('height')) clone.setAttribute('height', height);
    clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
    return new XMLSerializer().serializeToString(clone);
  }, []);

  const handleExportSVG = useCallback(() => {
    const svg = serializeSvg();
    if (!svg) return;
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    download(url, `${effectiveExportName ?? title.replace(/\s+/g, '-').toLowerCase()}.svg`);
    URL.revokeObjectURL(url);
  }, [serializeSvg, effectiveExportName, title]);

  const handleExportPNG = useCallback(() => {
    const svg = serializeSvg();
    if (!svg) return;
    const img = new Image();
    const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width * 2;
      canvas.height = img.height * 2;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(2, 2);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      download(canvas.toDataURL('image/png'), `${effectiveExportName ?? title.replace(/\s+/g, '-').toLowerCase()}.png`);
    };
    img.src = url;
  }, [serializeSvg, effectiveExportName, title]);

  return (
    <section
      className={`chart-card flex flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900 ${className ?? ''}`}
      data-testid="chart-card"
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
          {subtitle ? (
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{subtitle}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {actions}
          <button
            type="button"
            onClick={handleExportPNG}
            className="rounded md-rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            aria-label="Export chart as PNG"
          >
            PNG
          </button>
          <button
            type="button"
            onClick={handleExportSVG}
            className="rounded md-rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            aria-label="Export chart as SVG"
          >
            SVG
          </button>
        </div>
      </div>

      {error ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="rounded border border-slate-200 px-3 py-1 text-xs dark:border-slate-700"
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : loading ? (
        <div className="flex h-48 items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
        </div>
      ) : (
        <div ref={containerRef} className="min-h-48 w-full">{children}</div>
      )}
    </section>
  );
}

export default ChartCard;
