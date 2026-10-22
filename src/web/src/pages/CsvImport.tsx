import { useMemo, useState } from "react";
import { parseCsv } from "../../../shared/csv";
import { applyMapping, guessMapping, type CsvMapping } from "../../../shared/csv-mapping";
import { DATE_FORMATS, type DateFormat } from "../../../shared/dates";
import { api, ApiError, type Account, type Household, type ImportResult } from "../api";
import { onLinkClick } from "../router";
import { Money } from "../ui";

const MAX_BYTES = 2 * 1024 * 1024;

export function CsvImport({ household, account, onDone, onCancel }: { household: Household; account: Account; onDone: () => void; onCancel: () => void }) {
  const [filename, setFilename] = useState("");
  const [text, setText] = useState("");
  const [mapping, setMapping] = useState<CsvMapping | null>(null);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const table = useMemo(() => (text ? parseCsv(text) : []), [text]);
  const preview = useMemo(() => (mapping && table.length ? applyMapping(table, mapping, household.currency) : null), [mapping, table, household.currency]);
  const columns = useMemo(() => {
    const width = Math.max(0, ...table.slice(0, 20).map((r) => r.length));
    const header = mapping?.hasHeader ? table[0] ?? [] : [];
    return Array.from({ length: width }, (_, i) => header[i] || `Column ${i + 1}`);
  }, [table, mapping?.hasHeader]);

  async function pick(file: File | undefined) {
    setError(null);
    setResult(null);
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError("Files up to 2 MB can be imported at once. Export a shorter date range.");
      return;
    }
    const content = await file.text();
    const rows = parseCsv(content);
    if (rows.length < 2) {
      setError("That file has no rows to import.");
      return;
    }
    setFilename(file.name);
    setText(content);
    setMapping(account.csvMapping ?? guessMapping(rows));
  }

  function update<K extends keyof CsvMapping>(key: K, value: CsvMapping[K]) {
    setMapping((m) => (m ? { ...m, [key]: value } : m));
  }

  async function runImport() {
    if (!mapping) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.importCsv(household.id, account.id, { csv: text, filename, mapping, saveMapping: remember }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "The import failed");
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <section className="card stack" aria-live="polite">
        <h2>Imported {filename}</h2>
        <ul className="plain">
          <li>
            <strong>{result.autoPosted}</strong> added straight to {account.name}, using categories remembered from earlier.
          </li>
          {result.confirmed > 0 && (
            <li>
              <strong>{result.confirmed}</strong> matched entries the family had already logged, so they are now confirmed by the bank instead of counted twice.
            </li>
          )}
          <li>
            <strong>{result.needsReview}</strong> waiting in Decide for a category or a "same payment?" check
            {result.duplicates ? `, ${result.duplicates} of them possible double entries` : ""}.
          </li>
          {result.alreadyQueued > 0 && (
            <li>
              <strong>{result.alreadyQueued}</strong> already waiting in Decide from an earlier import, so not added again.
            </li>
          )}
          {result.skipped > 0 && (
            <li>
              <strong>{result.skipped}</strong> rows skipped because the date or amount could not be read.
            </li>
          )}
        </ul>
        <div className="row">
          {result.needsReview > 0 && (
            <a className="button" href={`/h/${household.id}/decide`} onClick={onLinkClick}>
              Decide on {result.needsReview} {result.needsReview === 1 ? "line" : "lines"}
            </a>
          )}
          <button type="button" className="secondary" onClick={onDone}>
            Done
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="card stack" aria-labelledby="import-heading">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="import-heading">Import a CSV into {account.name}</h2>
        <button type="button" className="quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <span className="muted">
        Download a CSV export from your bank's website and choose it here. The column choices are remembered for this account, and CSV attachments
        on forwarded statement emails will use them too.
      </span>
      <label>
        CSV file
        <input type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files?.[0])} />
      </label>

      {mapping && table.length > 0 && (
        <>
          <div className="mapping">
            <label className="check">
              <input type="checkbox" checked={mapping.hasHeader} onChange={(e) => update("hasHeader", e.target.checked)} />
              First row is a header
            </label>
            <label>
              Date column
              <ColumnSelect columns={columns} value={mapping.dateColumn} onChange={(v) => update("dateColumn", v)} />
            </label>
            <label>
              Date format
              <select value={mapping.dateFormat} onChange={(e) => update("dateFormat", e.target.value as DateFormat)}>
                {DATE_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Description column
              <ColumnSelect columns={columns} value={mapping.descriptionColumn} onChange={(v) => update("descriptionColumn", v)} />
            </label>
            <label>
              Amounts
              <select value={mapping.amountMode} onChange={(e) => update("amountMode", e.target.value as CsvMapping["amountMode"])}>
                <option value="single">One amount column</option>
                <option value="split">Separate money out and money in columns</option>
              </select>
            </label>
            {mapping.amountMode === "single" ? (
              <>
                <label>
                  Amount column
                  <ColumnSelect columns={columns} value={mapping.amountColumn ?? 0} onChange={(v) => update("amountColumn", v)} />
                </label>
                <label>
                  Money out is shown as
                  <select value={mapping.negativeIsOut ? "negative" : "positive"} onChange={(e) => update("negativeIsOut", e.target.value === "negative")}>
                    <option value="negative">Negative numbers (most banks)</option>
                    <option value="positive">Positive numbers (most credit cards)</option>
                  </select>
                </label>
              </>
            ) : (
              <>
                <label>
                  Money out column
                  <ColumnSelect columns={columns} value={mapping.debitColumn ?? 0} onChange={(v) => update("debitColumn", v)} />
                </label>
                <label>
                  Money in column
                  <ColumnSelect columns={columns} value={mapping.creditColumn ?? 0} onChange={(v) => update("creditColumn", v)} />
                </label>
              </>
            )}
            <label>
              Decimal separator
              <select value={mapping.decimalSeparator} onChange={(e) => update("decimalSeparator", e.target.value as "." | ",")}>
                <option value=".">1,234.56</option>
                <option value=",">1.234,56</option>
              </select>
            </label>
          </div>

          {preview && (
            <div className="stack">
              <span>
                <strong>{preview.rows.length}</strong> transactions read
                {preview.errors.length > 0 && (
                  <span className="warn">
                    , {preview.errors.length} rows could not be read (first: line {preview.errors[0]!.line}, {preview.errors[0]!.reason})
                  </span>
                )}
                . Check the first few look right:
              </span>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Description</th>
                      <th className="right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 8).map((r) => (
                      <tr key={r.line}>
                        <td className="mono">{r.date}</td>
                        <td>{r.description}</td>
                        <td className="right">
                          <Money minor={r.amountMinor} currency={household.currency} signed={r.direction} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <label className="check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Remember these columns for {account.name}
          </label>
          {error && <div className="error">{error}</div>}
          <div>
            <button type="button" onClick={runImport} disabled={busy || !preview?.rows.length}>
              {busy ? "Importing…" : `Import ${preview?.rows.length ?? 0} transactions`}
            </button>
          </div>
        </>
      )}
      {!mapping && error && <div className="error">{error}</div>}
    </section>
  );
}

function ColumnSelect({ columns, value, onChange }: { columns: string[]; value: number; onChange: (v: number) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {columns.map((name, i) => (
        <option key={i} value={i}>
          {name}
        </option>
      ))}
    </select>
  );
}
