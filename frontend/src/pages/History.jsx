import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import DashboardLayout from '../components/layout/DashboardLayout';
import api from '../api/client';
import styles from './History.module.css';

const CHART_W = 640;
const CHART_H = 220;
const PAD = 20;

// Cycled by index across tracked keywords — the theme only defines a handful
// of semantic color tokens (styles/tokens.css), not a categorical palette, so
// this reuses them as a small line-color rotation rather than adding new ones.
const RANK_LINE_COLORS = ['var(--accent)', 'var(--success)', 'var(--warning)', 'var(--danger)', 'var(--accent-text)', 'var(--text-muted)'];

// Merges per-keyword {checkedAt, position} series into one row per day
// (Recharts wants a single array with one field per line), keyed by keyword
// so each Line's dataKey can pick its own column straight out of the row.
function buildRankRows(rankHistory) {
  const rowsByDate = new Map();
  for (const { keyword, points } of rankHistory) {
    for (const point of points) {
      const date = new Date(point.checkedAt).toISOString().slice(0, 10);
      if (!rowsByDate.has(date)) rowsByDate.set(date, { date });
      rowsByDate.get(date)[keyword] = point.position;
    }
  }
  return Array.from(rowsByDate.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
}

export default function History() {
  const { t, i18n } = useTranslation();
  const [searchParams] = useSearchParams();
  const domain = searchParams.get('domain') || '';
  const [rows, setRows] = useState([]);
  const [rankHistory, setRankHistory] = useState([]);
  const [hiddenKeywords, setHiddenKeywords] = useState(() => new Set());

  function toggleKeyword(keyword) {
    setHiddenKeywords((prev) => {
      const next = new Set(prev);
      if (next.has(keyword)) next.delete(keyword);
      else next.add(keyword);
      return next;
    });
  }

  useEffect(() => {
    if (!domain) return;
    api.get('/audit').then(({ data }) => {
      const filtered = data
        .filter((a) => a.domain === domain && a.score != null)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      setRows(filtered);
    });
    api.get(`/rank-tracking/history?domain=${encodeURIComponent(domain)}`).then(({ data }) => setRankHistory(data));
  }, [domain]);

  const rankKeywords = rankHistory.map((h) => h.keyword);
  const rankRows = buildRankRows(rankHistory);

  if (!domain) {
    return (
      <DashboardLayout maxWidth={1000}>
        <p className={styles.empty}>{t('report.noResultsYet')}</p>
      </DashboardLayout>
    );
  }

  const points = rows.map((r, i) => ({
    x: rows.length > 1 ? PAD + (i * (CHART_W - 2 * PAD)) / (rows.length - 1) : CHART_W / 2,
    y: CHART_H - PAD - (r.score / 100) * (CHART_H - 2 * PAD),
  }));
  const polyline = points.map((p) => `${p.x},${p.y}`).join(' ');
  const totalDelta = rows.length > 1 ? rows[rows.length - 1].score - rows[0].score : 0;

  const tableRows = rows
    .map((r, i) => {
      const prev = rows[i - 1];
      const delta = prev ? r.score - prev.score : null;
      return { ...r, delta };
    })
    .reverse();

  return (
    <DashboardLayout maxWidth={1000}>
      <h1 className={styles.title}>{t('history.title', { domain: domain.replace(/^https?:\/\//, '') })}</h1>
      <p className={styles.subtitle}>{t('history.subtitle')}</p>

      {rows.length === 0 ? (
        <p className={styles.empty}>{t('report.noResultsYet')}</p>
      ) : (
        <>
          <div className={styles.chartCard}>
            {rows.length > 1 && (
              <div className={styles.badge}>
                {t('history.badge', { delta: totalDelta >= 0 ? `+${totalDelta}` : totalDelta })}
              </div>
            )}
            <svg width="100%" height={CHART_H} viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none">
              <line x1="0" y1="20" x2={CHART_W} y2="20" stroke="var(--border)" strokeDasharray="4 4" />
              <line x1="0" y1="90" x2={CHART_W} y2="90" stroke="var(--border)" strokeDasharray="4 4" />
              <line x1="0" y1="160" x2={CHART_W} y2="160" stroke="var(--border)" strokeDasharray="4 4" />
              {points.length > 1 && (
                <polyline points={polyline} fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              )}
              {points.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r="5" fill="var(--surface)" stroke="var(--accent)" strokeWidth="3" />
              ))}
            </svg>
            <div className={styles.monthsRow}>
              {rows.map((r) => (
                <span key={r.id} className={styles.monthLabel}>
                  {new Date(r.created_at).toLocaleDateString(i18n.resolvedLanguage, { month: 'short' })}
                </span>
              ))}
            </div>
          </div>

          <div className={styles.tableCard}>
            <div className={styles.headRow}>
              <span>{t('history.colDate')}</span>
              <span>{t('history.colScore')}</span>
              <span>{t('history.colIssues')}</span>
              <span>{t('history.colChange')}</span>
            </div>
            {tableRows.map((r) => (
              <div className={styles.row} key={r.id}>
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{new Date(r.created_at).toLocaleDateString(i18n.resolvedLanguage)}</span>
                <span className="mono" style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{r.score}</span>
                <span className="mono" style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                  {r.issue_count ?? '—'}
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: r.delta == null ? 'var(--text-faint)' : r.delta >= 0 ? 'var(--success)' : 'var(--danger)',
                  }}
                >
                  {r.delta == null ? 'n/a' : r.delta >= 0 ? `+${r.delta}` : r.delta}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className={styles.chartCard} style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: 'var(--text)' }}>{t('history.rankTitle')}</h2>
        <p className={styles.subtitle} style={{ marginTop: 4 }}>{t('history.rankSubtitle')}</p>
        {rankRows.length === 0 ? (
          <p className={styles.empty}>{t('history.rankEmptyState')}</p>
        ) : (
          <div style={{ width: '100%', height: 260, marginTop: 12 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rankRows}>
                <CartesianGrid strokeDasharray="4 4" stroke="var(--border)" />
                <XAxis dataKey="date" tick={{ fontSize: 12, fill: 'var(--text-faint)' }} />
                <YAxis
                  reversed
                  allowDecimals={false}
                  domain={[1, 10]}
                  ticks={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]}
                  tick={{ fontSize: 12, fill: 'var(--text-faint)' }}
                />
                <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13 }} />
                <Legend
                  wrapperStyle={{ fontSize: 12, cursor: 'pointer' }}
                  onClick={(entry) => toggleKeyword(entry.dataKey)}
                  formatter={(value, entry) => (
                    <span
                      style={{
                        opacity: hiddenKeywords.has(entry.dataKey) ? 0.4 : 1,
                        textDecoration: hiddenKeywords.has(entry.dataKey) ? 'line-through' : 'none',
                      }}
                    >
                      {value}
                    </span>
                  )}
                />
                {rankKeywords.map((keyword, i) => (
                  <Line
                    key={keyword}
                    type="monotone"
                    dataKey={keyword}
                    stroke={RANK_LINE_COLORS[i % RANK_LINE_COLORS.length]}
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    connectNulls={false}
                    hide={hiddenKeywords.has(keyword)}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
            {rankKeywords.length > 1 && <p className={styles.empty} style={{ padding: 0, marginTop: 8, fontSize: 12 }}>{t('history.rankLegendHint')}</p>}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
