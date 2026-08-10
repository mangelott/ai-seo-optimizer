import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import DashboardLayout from '../components/layout/DashboardLayout';
import api from '../api/client';
import styles from './History.module.css';

const CHART_W = 640;
const CHART_H = 220;
const PAD = 20;

export default function History() {
  const { t, i18n } = useTranslation();
  const [searchParams] = useSearchParams();
  const domain = searchParams.get('domain') || '';
  const [rows, setRows] = useState([]);

  useEffect(() => {
    if (!domain) return;
    api.get('/audit').then(({ data }) => {
      const filtered = data
        .filter((a) => a.domain === domain && a.score != null)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      setRows(filtered);
    });
  }, [domain]);

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
    </DashboardLayout>
  );
}
