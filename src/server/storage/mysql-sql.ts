import { importTables } from './schema-v1.js';

/** Transitional SQL dialect boundary. No data or parameters are interpolated here. */
export function mysqlSql(input: string): string {
  let sql = input.trim().replace(/;$/, '');
  if (/^(CREATE|ALTER|DROP|SET)\b/i.test(sql)) return sql;
  if (/^PRAGMA\b/i.test(sql)) throw new Error('SQLite PRAGMA is not supported by MySQL');
  sql = sql.replace(/\bINSERT OR REPLACE\b/gi, 'REPLACE');
  const ignore = /^INSERT OR IGNORE\b/i.test(sql);
  sql = sql.replace(/^INSERT OR IGNORE\b/i, 'INSERT');
  const target = /\bON CONFLICT\s*\(([^)]+)\)\s+DO (?:UPDATE SET\s+([\s\S]*)|NOTHING)$/i.exec(sql);
  const table = /^INSERT\s+INTO\s+(\w+)/i.exec(sql)?.[1];
  const pk = importTables.find(t => t.name === table)?.columns.find(c => c.pk)?.name;
  if (target) {
    if (!pk) throw new Error('Upsert table requires a primary key');
    // Unlike SQLite, MySQL handles ANY unique conflict. Guard the explicit target
    // so a collision on another unique index cannot silently update a different row.
    const sameTarget = target[1].split(',').map(c => {
      const name = c.trim();
      return `\`${name}\` IS NOT NULL AND \`${name}\`=VALUES(\`${name}\`)`;
    }).join(' AND ');
    sql = sql.slice(0, target.index) + `ON DUPLICATE KEY UPDATE \`${pk}\`=IF(${sameTarget},\`${pk}\`,NULL)` + (target[2] ? ", " + target[2] : "");
  } else if (ignore) {
    if (!pk) throw new Error('Insert-ignore table requires a primary key');
    // Do not use INSERT IGNORE: it also suppresses truncation and FK errors.
    sql += ` ON DUPLICATE KEY UPDATE \`${pk}\`=\`${pk}\``;
  }
  sql = sql.replace(/\b(MAX|MIN)\(([^(),]+),\s*([^(),]+)\)/gi, (_, fn, a, b) => `${fn.toUpperCase() === "MAX" ? "GREATEST" : "LEAST"}(${a},${b})`);
  sql = sql.replace(/\bexcluded\.(\w+)/gi, 'VALUES($1)');
  // Unqualified KEY is a MySQL reserved word; string literals stay untouched.
  sql = sql.replace(/'(?:''|[^'])*'|`[^`]*`|\b(?:key|cursor)\b/gi, token => /^(?:key|cursor)$/i.test(token) ? '`'+token+'`' : token);
  sql = sql.replace(/DUPLICATE `key` UPDATE/gi, 'DUPLICATE KEY UPDATE');
  sql = sql.replace(/\bdatetime\('now',\s*\?\)/gi, 'DATE_ADD(UTC_TIMESTAMP(), INTERVAL CAST(? AS SIGNED) DAY)');
  sql = sql.replace(/\b(?:datetime|julianday)\((VALUES\(\w+\)|[\w.]+|\?)\)/gi,
    (_, value) => `CAST(REPLACE(REPLACE(NULLIF(${value},''), 'T', ' '), 'Z', '') AS DATETIME(6))`);
  sql = sql.replace(/\bdatetime\(\?,\s*'-5 minutes'\)/gi, "DATE_SUB(CAST(REPLACE(REPLACE(?, 'T', ' '), 'Z', '') AS DATETIME(6)), INTERVAL 5 MINUTE)");
  sql = sql.replace(/GROUP_CONCAT\((p\.target \|\| ':' \|\| p\.status), ', '\)/g, "GROUP_CONCAT($1 SEPARATOR ', ')");
  sql = sql.replace(/json_each\(\s*(CASE WHEN json_valid\(p\.available_methods_json\) THEN p\.available_methods_json ELSE '\[\]' END)\s*\) jm/g,
    (_, value) => `JSON_TABLE(${value}, '$[*]' COLUMNS (value VARCHAR(255) PATH '$')) jm`);
  // JSON_TABLE cannot project an object into a JSON typed column; expand indices
  // and extract the original value to preserve objects without double encoding.
  sql = sql.replace(/json_each\(\s*(CASE WHEN json_valid\(p\.payment_methods_json\) THEN p\.payment_methods_json ELSE '\[\]' END)\s*\) jm/g,
    "JSON_TABLE($1, '$[*]' COLUMNS (ordinal FOR ORDINALITY)) jm");
  sql = sql.replace(/json_group_array\(json\(jm\.value\)\)/g,
    "JSON_ARRAYAGG(JSON_EXTRACT(p.payment_methods_json, CONCAT('$[',jm.ordinal-1,']')))");
  sql = sql.replace(/json_type\(jm\.value\)='object'/g,
    "JSON_TYPE(JSON_EXTRACT(p.payment_methods_json, CONCAT('$[',jm.ordinal-1,']')))='OBJECT'");
  sql = sql.replace(/json_extract\(rejected_claim\.payload_json,'\$\.messageId'\)/g,
    "JSON_UNQUOTE(JSON_EXTRACT(rejected_claim.payload_json,'$.messageId'))");
  if (/sqlite_master/.test(sql)) sql = sql.replace(/sqlite_master/g, 'information_schema.tables')
    .replace(/type='table' AND name=/g, "table_schema=DATABASE() AND table_name=");
  if (/^SELECT COUNT\(\*\)\s+(?:AS\s+)?\w+\s+FROM\s*\(/i.test(sql) && sql.endsWith(")")) sql += " AS counted_rows";
  return sql;
}
