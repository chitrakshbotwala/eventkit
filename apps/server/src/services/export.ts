import ExcelJS from 'exceljs';

const BOM = String.fromCharCode(0xfeff);

export type Cell = string | number | boolean | Date | null | undefined;

export interface Column<T> {
  header: string;
  width?: number;
  value: (row: T) => Cell;
}

/** Neutralise spreadsheet formula injection (=, +, -, @, tab, CR at the start). */
export function safeCell(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

function csvEscape(v: Cell): string {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : safeCell(String(v));
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv<T>(rows: T[], cols: Column<T>[]): string {
  const lines = [cols.map((c) => csvEscape(c.header)).join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvEscape(c.value(r))).join(','));
  // BOM so Excel opens UTF-8 names correctly.
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

export async function toXlsx<T>(rows: T[], cols: Column<T>[], sheetName: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'EventKit';
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName);
  ws.columns = cols.map((c) => ({ header: c.header, width: c.width ?? 20 }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of rows) {
    ws.addRow(
      cols.map((c) => {
        const v = c.value(r);
        return typeof v === 'string' ? safeCell(v) : (v ?? null);
      }),
    );
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
