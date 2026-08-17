import { useEffect, useState, lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import DashboardLayout from '../components/layout/DashboardLayout';
import Button from '../components/ui/Button';
import PaywallModal from '../components/PaywallModal';
import ReportBody from '../components/ReportBody';
import api from '../api/client';
import styles from './Report.module.css';

// @react-pdf/renderer is ~600KB gzipped — only worth loading for the few
// users on a plan that actually has PDF export, and only once they land here.
const PdfExportLink = lazy(() => import('../components/PdfExportLink'));

const PDF_PLANS = ['pro', 'agency'];

export default function Report() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const [audit, setAudit] = useState(null);
  const [previousScore, setPreviousScore] = useState(null);
  const [showPaywall, setShowPaywall] = useState(false);
  const [plan, setPlan] = useState(null);
  const [shareBusy, setShareBusy] = useState(false);

  useEffect(() => {
    api.get(`/audit/${id}`).then(({ data }) => setAudit(data));
  }, [id]);

  useEffect(() => {
    api.get('/auth/me').then(({ data }) => setPlan(data.plan));
  }, []);

  useEffect(() => {
    if (!audit) return;
    api.get('/audit').then(({ data }) => {
      const sameDomain = data
        .filter((a) => a.domain === audit.domain && a.id !== audit.id && a.score != null)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      if (sameDomain[0]) setPreviousScore(sameDomain[0].score);
    });
  }, [audit]);

  async function toggleShare() {
    setShareBusy(true);
    try {
      const { data } = await api.patch(`/audit/${id}/share`, { shared: !audit.is_shared });
      setAudit((a) => ({ ...a, is_shared: data.is_shared, share_token: data.share_token }));
    } finally {
      setShareBusy(false);
    }
  }

  if (!audit) {
    return (
      <DashboardLayout maxWidth={1100}>
        <p>{t('common.loading')}</p>
      </DashboardLayout>
    );
  }

  const delta = previousScore != null && audit.score != null ? audit.score - previousScore : null;
  const shareUrl = audit.share_token
    ? `${window.location.origin}/report/${audit.share_token}`
    : null;

  return (
    <DashboardLayout maxWidth={1100}>
      <ReportBody
        audit={audit}
        delta={delta}
        headerActions={
          <>
            {PDF_PLANS.includes(plan) ? (
              <Suspense fallback={<Button variant="secondary" disabled>{t('common.loading')}</Button>}>
                <PdfExportLink
                  audit={audit}
                  appName={t('common.appName')}
                  loadingLabel={t('common.loading')}
                  label={t('report.exportPdf')}
                />
              </Suspense>
            ) : (
              <Button variant="secondary" onClick={() => setShowPaywall(true)}>
                {t('report.exportPdf')}
              </Button>
            )}
            <Button variant="secondary" onClick={() => navigate(`/history?domain=${encodeURIComponent(audit.domain)}`)}>
              {t('report.seeHistory')}
            </Button>
            <Button variant="secondary" onClick={toggleShare} disabled={shareBusy}>
              {audit.is_shared ? t('report.unshare') : t('report.share')}
            </Button>
          </>
        }
      />

      {audit.is_shared && shareUrl && (
        <div className={styles.shareBox}>
          <span className={styles.shareLabel}>{t('report.shareLinkLabel')}</span>
          <input readOnly value={shareUrl} onFocus={(e) => e.target.select()} className={styles.shareInput} />
          <Button
            size="sm"
            onClick={() => navigator.clipboard.writeText(shareUrl)}
          >
            {t('report.copyLink')}
          </Button>
        </div>
      )}

      {showPaywall && <PaywallModal onClose={() => setShowPaywall(false)} />}
    </DashboardLayout>
  );
}
