import { useEffect, useState } from 'react';
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import PublicHeader from '../components/layout/PublicHeader';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import ScoreRing from '../components/ui/ScoreRing';
import api from '../api/client';
import { SEVERITY_LEVELS, severityLabelKey } from '../lib/severity';
import styles from './QuickScanTeaser.module.css';

export default function QuickScanTeaser() {
  const { t } = useTranslation();
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const domain = searchParams.get('domain') || '';
  const navigate = useNavigate();
  const [scan, setScan] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get(`/quick-scan/${id}`)
      .then(({ data }) => setScan(data))
      .catch(() => setError('not_found'));
  }, [id]);

  if (error) {
    return (
      <div>
        <PublicHeader />
        <div className={styles.wrap}>
          <p>{t('report.noResultsYet')}</p>
        </div>
      </div>
    );
  }

  if (!scan) {
    return (
      <div>
        <PublicHeader />
        <div className={styles.wrap}>
          <p>{t('common.loading')}</p>
        </div>
      </div>
    );
  }

  const displayDomain = domain || scan.domain;
  const highImpactCount = Math.max(1, Math.round(scan.issuesCount / 4));
  const rowCount = Math.min(4, scan.issuesCount || 3);

  return (
    <div>
      <PublicHeader />
      <div className={styles.wrap}>
        <span className="mono" style={{ display: 'inline-block', fontSize: 12, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--accent-text)', background: 'var(--accent-soft)', padding: '6px 12px', borderRadius: 999, marginBottom: 16 }}>
          {t('quickscan.eyebrow')}
        </span>
        <h1 className={styles.title}>
          {t('quickscan.resultFor')} <span style={{ color: 'var(--accent-text)' }}>{displayDomain}</span>
        </h1>

        <div className={styles.card}>
          <div className={styles.ringWrap}>
            <div className={styles.ringInner}>
              <ScoreRing score={scan.score} size={160} strokeWidth={14} labelSuffix="/ 100" />
            </div>
          </div>
          <p className={styles.headline}>{t('quickscan.issuesFound', { count: scan.issuesCount })}</p>
          <p className={styles.subline}>{t('quickscan.highImpactNote', { count: highImpactCount })}</p>

          <div className={styles.lockedList}>
            {Array.from({ length: rowCount }).map((_, i) => {
              const level = SEVERITY_LEVELS[i % SEVERITY_LEVELS.length];
              return (
                <div className={styles.lockedRow} key={i}>
                  <Badge variant={level}>{t(severityLabelKey(level))}</Badge>
                  <span style={{ fontSize: 14, color: 'var(--text)' }}>██████████████████</span>
                </div>
              );
            })}
          </div>

          <div className={styles.lockOverlay}>
            <div className={styles.lockIcon}>🔒</div>
            <p className={styles.lockTitle}>{t('quickscan.lockTitle')}</p>
            <p className={styles.lockSubtitle}>{t('quickscan.lockSubtitle', { count: scan.issuesCount })}</p>
            <Button
              full
              style={{ marginTop: 18 }}
              onClick={() =>
                navigate(`/register?scanId=${id}&domain=${encodeURIComponent(displayDomain)}`)
              }
            >
              {t('quickscan.lockCta')}
            </Button>
            <p className={styles.footerNote}>
              {t('quickscan.alreadyHaveAccount')}{' '}
              <Link to="/login" className={styles.linkAccent}>
                {t('quickscan.login')}
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
