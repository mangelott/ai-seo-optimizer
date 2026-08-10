import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import DashboardLayout from '../components/layout/DashboardLayout';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import ScoreRing from '../components/ui/ScoreRing';
import api from '../api/client';
import styles from './Dashboard.module.css';

function withDeltas(audits) {
  const byDomain = {};
  const sorted = [...audits].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  sorted.forEach((a) => {
    const prev = byDomain[a.domain];
    a._delta = prev != null && a.score != null ? a.score - prev : null;
    if (a.score != null) byDomain[a.domain] = a.score;
  });
  return audits.map((a) => sorted.find((s) => s.id === a.id));
}

export default function Dashboard() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [audits, setAudits] = useState([]);
  const [domain, setDomain] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function loadAudits() {
    const { data } = await api.get('/audit');
    setAudits(withDeltas(data));
  }

  useEffect(() => {
    loadAudits();
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const url = /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
    try {
      const { data } = await api.post('/audit', { domain: url, language: i18n.resolvedLanguage });
      navigate(`/audits/${data.auditId}/processing`);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not start audit');
    } finally {
      setLoading(false);
    }
  }

  const domainsCount = new Set(audits.map((a) => a.domain)).size;

  return (
    <DashboardLayout>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>{t('dashboard.title')}</h1>
          <p className={styles.subtitle}>{t('dashboard.sitesMonitored', { count: domainsCount })}</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className={styles.newAuditForm}>
        <Input
          type="text"
          placeholder={t('dashboard.urlPlaceholder')}
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          required
        />
        <Button type="submit" disabled={loading}>
          {t('dashboard.newAudit')}
        </Button>
      </form>
      {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 16 }}>{error}</p>}

      {audits.length === 0 ? (
        <p className={styles.empty}>{t('dashboard.noAudits')}</p>
      ) : (
        <div className={styles.grid}>
          {audits.map((a) => {
            const isPending = a.status === 'pending';
            const isAttention = !isPending && a.score != null && a.score < 50;
            const badgeVariant = isPending ? 'neutral' : isAttention ? 'medium' : 'success';
            const badgeLabel = isPending
              ? t('dashboard.statusProcessing')
              : isAttention
                ? t('dashboard.statusAttention')
                : t('dashboard.statusCompleted');

            return (
              <div
                key={a.id}
                className={styles.card}
                onClick={() =>
                  navigate(isPending ? `/audits/${a.id}/processing` : `/audits/${a.id}`)
                }
              >
                <div className={styles.cardTop}>
                  <div>
                    <div className={styles.domain}>{a.domain.replace(/^https?:\/\//, '')}</div>
                    <div className={styles.date}>{new Date(a.created_at).toLocaleDateString(i18n.resolvedLanguage)}</div>
                  </div>
                  <Badge variant={badgeVariant}>{badgeLabel}</Badge>
                </div>

                {isPending ? (
                  <div className={styles.processingRow}>
                    <div className={styles.spinner} />
                    <span style={{ fontSize: 13, color: 'var(--text-faint)' }}>{t('dashboard.processing')}</span>
                  </div>
                ) : (
                  <div className={styles.scoreRow}>
                    <ScoreRing score={a.score ?? 0} size={56} strokeWidth={6} fontSize={16} />
                    <div>
                      <div className={styles.issueCount}>
                        {a.issue_count ?? 0} {t('dashboard.issues')}
                      </div>
                      {a._delta != null && (
                        <div
                          className={styles.delta}
                          style={{ color: a._delta >= 0 ? 'var(--success)' : 'var(--danger)' }}
                        >
                          {a._delta >= 0 ? `+${a._delta}` : a._delta}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </DashboardLayout>
  );
}
