import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DashboardLayout from '../components/layout/DashboardLayout';
import Button from '../components/ui/Button';
import PaywallModal from '../components/PaywallModal';
import api from '../api/client';
import styles from './Billing.module.css';

export default function Billing() {
  const { t, i18n } = useTranslation();
  const [summary, setSummary] = useState(null);
  const [showPaywall, setShowPaywall] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);

  useEffect(() => {
    api.get('/billing/summary').then(({ data }) => setSummary(data));
  }, []);

  async function openPortal() {
    setPortalLoading(true);
    try {
      const { data } = await api.post('/billing/portal');
      window.location.href = data.url;
    } catch {
      setPortalLoading(false);
    }
  }

  if (!summary) {
    return (
      <DashboardLayout maxWidth={760}>
        <p>{t('common.loading')}</p>
      </DashboardLayout>
    );
  }

  const usagePct = summary.auditsLimit
    ? Math.min(100, Math.round((summary.auditsThisMonth / summary.auditsLimit) * 100))
    : Math.min(100, summary.auditsThisMonth * 10);

  return (
    <DashboardLayout maxWidth={760}>
      <h1 className={styles.title}>{t('billing.title')}</h1>

      <div className={styles.card}>
        <div className={styles.planRow}>
          <div className={styles.planBadge}>
            <div className={styles.planLabel}>{t('billing.currentPlan')}</div>
            <div className={styles.planValue}>{summary.planName}</div>
          </div>
          <Button size="sm" onClick={() => setShowPaywall(true)}>
            {t('billing.changePlan')}
          </Button>
        </div>
        <div style={{ marginTop: 20 }}>
          <div className={styles.usageRow}>
            <span>{t('billing.auditsThisMonth')}</span>
            <span className="mono" style={{ fontWeight: 600, color: 'var(--text)' }}>
              {summary.auditsThisMonth} / {summary.auditsLimit ?? t('billing.unlimited')}
            </span>
          </div>
          <div className={styles.usageTrack}>
            <div className={styles.usageFill} style={{ width: `${usagePct}%` }} />
          </div>
        </div>
      </div>

      <div className={styles.card}>
        <h3 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: 'var(--text)' }}>{t('billing.paymentMethod')}</h3>
        <div className={styles.pmRow}>
          <div className={styles.pmLeft}>
            <div className={styles.cardChip}>{summary.paymentMethod?.brand || 'card'}</div>
            <span style={{ fontSize: 14, color: 'var(--text)' }}>
              {summary.paymentMethod ? `•••• ${summary.paymentMethod.last4}` : '—'}
            </span>
          </div>
          <Button variant="secondary" size="sm" onClick={openPortal} disabled={portalLoading}>
            {t('billing.change')}
          </Button>
        </div>
      </div>

      <div className={`${styles.card} ${styles.tableCard}`}>
        <div className={styles.tableTitle}>
          <h3 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: 'var(--text)' }}>{t('billing.invoiceHistory')}</h3>
        </div>
        {summary.invoices.length > 0 && (
          <div className={styles.headRow}>
            <span>{t('billing.colDate')}</span>
            <span>{t('billing.colDescription')}</span>
            <span>{t('billing.colAmount')}</span>
            <span></span>
          </div>
        )}
        {summary.invoices.length === 0 ? (
          <p style={{ padding: 20, fontSize: 14, color: 'var(--text-faint)' }}>—</p>
        ) : (
          summary.invoices.map((inv, i) => (
            <div className={styles.row} key={i}>
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{new Date(inv.date).toLocaleDateString(i18n.resolvedLanguage)}</span>
              <span style={{ fontSize: 13, color: 'var(--text)' }}>{inv.description}</span>
              <span className="mono" style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                {inv.amount} {inv.currency?.toUpperCase()}
              </span>
              {inv.pdfUrl && (
                <a href={inv.pdfUrl} target="_blank" rel="noreferrer" className={styles.pdfLink}>
                  PDF
                </a>
              )}
            </div>
          ))
        )}
      </div>

      {showPaywall && <PaywallModal onClose={() => setShowPaywall(false)} />}
    </DashboardLayout>
  );
}
