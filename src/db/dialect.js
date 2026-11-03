'use strict';
// SQL dialect translation: the application is written against SQLite's flavour.
//
// Only the differences the codebase actually uses are handled, and anything we
// cannot translate throws instead of being sent to PostgreSQL to fail later.
//
//   ?            -> $1, $2, ...          (positional parameters)
//   INSERT OR IGNORE INTO -> INSERT INTO ... ON CONFLICT DO NOTHING
//   PRAGMA ...   -> dropped (no PostgreSQL equivalent, SQLite-only tuning)
//
// Everything else in this codebase is already portable: no datetime()/strftime,
// no AUTOINCREMENT, no last_insert_rowid(), no json_extract, and every id is a
// TEXT primary key generated in application code.

function translate(sql, params) {
  let out = String(sql);
  if (/^\s*pragma\b/i.test(out)) return { sql: null, params: [] };

  if (/^\s*insert\s+or\s+ignore\s+into/i.test(out)) {
    out = out.replace(/^\s*insert\s+or\s+ignore\s+into/i, 'INSERT INTO');
    out = out.replace(/;\s*$/, '') + ' ON CONFLICT DO NOTHING';
  } else if (/^\s*insert\s+or\s+replace\s+into/i.test(out)) {
    throw new Error('INSERT OR REPLACE has no safe PostgreSQL equivalent; rewrite the query');
  } else if (/^\s*replace\s+into/i.test(out)) {
    throw new Error('REPLACE INTO has no safe PostgreSQL equivalent; rewrite the query');
  }

  let n = 0;
  out = out.replace(/\?/g, () => `$${++n}`);
  if (n !== (params || []).length) {
    throw new Error(`placeholder/parameter mismatch: ${n} placeholders for ${(params || []).length} params`);
  }
  return { sql: out, params: params || [] };
}

module.exports = { translate };
