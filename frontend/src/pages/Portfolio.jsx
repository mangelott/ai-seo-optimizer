import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import DashboardLayout from '../components/layout/DashboardLayout';
import Badge from '../components/ui/Badge';
import api from '../api/client';
import styles from './Portfolio.module.css';

function compareRows(a, b, sortKey, sortDir) {
  let result;
  if (sortKey === 'domain') {
    result = a.domain.localeCompare(b.domain);
  } else {
    const aVal = a[sortKey];
    const bVal = b[sortKey];
    if (aVal == null && bVal == null) result = 0;
    else if (aVal == null) result = 1;
    else if (bVal == null) result = -1;
    else result = aVal - bVal;
  }
  return sortDir === 'asc' ? result : -result;
}

export default function Portfolio() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [plan, setPlan] = useState(null);
  const [rows, setRows] = useState([]);
  const [sortKey, setSortKey] = useState('domain');
  const [sortDir, setSortDir] = useState('asc');

  useEffect(() => {
    api.get('/auth/me').then(({ data }) => {
      setPlan(data.plan);
      // Portfolio is Agency-only — avoid the extra request for everyone else.
      if (data.plan === 'agency') {
        api.get('/teams/portfolio').then(({ data: portfolio }) => setRows(portfolio));
      }
    });
  }, []);

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => compareRows(a, b, sortKey, sortDir)),
    [rows, sortKey, sortDir]
  );

  function toggleSort(key) {
    if (key === sortKey) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  function sortIndicator(key) {
    if (key !== sortKey) return '';
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  }

  if (plan !== 'agency') {
    return (
      <DashboardLayout maxWidth={1000}>
        <h1 className={styles.title}>{t('portfolio.title')}</h1>
        <p className={styles.empty}>{t('portfolio.agencyOnly')}</p>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout maxWidth={1000}>
      <h1 className={styles.title}>{t('portfolio.title')}</h1>
      <p className={styles.subtitle}>{t('portfolio.subtitle')}</p>

      {rows.length === 0 ? (
        <p className={styles.empty}>{t('portfolio.emptyState')}</p>
      ) : (
        <div className={styles.tableCard}>
          <div className={styles.headRow}>
            <button className={styles.sortHeader} onClick={() => toggleSort('domain')}>
              {t('portfolio.colDomain')}{sortIndicator('domain')}
            </button>
            <button className={styles.sortHeader} onClick={() => toggleSort('latestScore')}>
              {t('portfolio.colScore')}{sortIndicator('latestScore')}
            </button>
            <button className={styles.sortHeader} onClick={() => toggleSort('trend')}>
              {t('portfolio.colTrend')}{sortIndicator('trend')}
            </button>
            <span>{t('portfolio.colAlerts')}</span>
          </div>
          {sortedRows.map((row) => (
            <div
              className={styles.row}
              key={row.domain}
              onClick={() => navigate(`/history?domain=${encodeURIComponent(row.domain)}`)}
            >
              <span className={styles.domain}>{row.domain.replace(/^https?:\/\//, '')}</span>
              <span className="mono" style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                {row.latestScore ?? '—'}
              </span>
              <span
                className="mono"
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: row.trend == null ? 'var(--text-faint)' : row.trend >= 0 ? 'var(--success)' : 'var(--danger)',
                }}
              >
                {row.trend == null ? 'n/a' : row.trend >= 0 ? `+${row.trend}` : row.trend}
              </span>
              <span>
                {row.alerts.length > 0 ? (
                  <Badge variant="high">{t('portfolio.alertScoreDrop', { delta: Math.abs(row.alerts[0].delta) })}</Badge>
                ) : (
                  <span style={{ fontSize: 13, color: 'var(--text-faint)' }}>—</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </DashboardLayout>
  );
}
