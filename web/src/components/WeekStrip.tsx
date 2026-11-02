/**
 * A figure's last weeks of records as a row of cells, oldest on the left:
 * the /tokoh board's activity column. The darker the cell, the more records
 * that week; the legend beside the board explains the steps.
 */

/** The darkness step for a week's count: 0 (none) to 4 (ten or more). */
export function weekLevel(n: number): number {
  if (n <= 0) return 0;
  if (n === 1) return 1;
  if (n <= 3) return 2;
  if (n <= 9) return 3;
  return 4;
}

function weekName(ago: number): string {
  return ago === 0 ? "7 hari terakhir" : `${ago} minggu sebelumnya`;
}

export default function WeekStrip({ counts }: { counts: number[] }) {
  const total = counts.reduce((a, b) => a + b, 0);
  return (
    <span className="wk-strip" role="img" aria-label={`${total} catatan dalam ${counts.length} minggu terakhir`}>
      {counts.map((n, i) => (
        <span
          key={i}
          className="wk-cell"
          data-level={weekLevel(n)}
          title={`${weekName(counts.length - 1 - i)}: ${n} catatan`}
        />
      ))}
    </span>
  );
}
