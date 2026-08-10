import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import DashboardLayout from '../components/layout/DashboardLayout';
import Button from '../components/ui/Button';
import ScoreRing from '../components/ui/ScoreRing';
import { PillFilter, SegmentedControl } from '../components/ui/SegmentedControl';
import FixCard from '../components/FixCard';
import PaywallModal from '../components/PaywallModal';
import api from '../api/client';
import styles from './Report.module.css';

const CATEGORIES = ['technical', 'content', 'keywords', 'backlinks'];
const SEVERITIES = ['all', 'high', 'medium', 'low'];
const IMPACT_COLOR = { high: 'var(--danger)', medium: 'var(--warning-strong)', low: 'var(--text-faint)' };

export default function Report() {
  const { t, i18n } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const [audit, setAudit] = useState(null);
  const [previousScore, setPreviousScore] = useState(null);
  const [tab, setTab] = useState('technical');
  const [severity, setSeverity] = useState('all');
  const [expandedId, setExpandedId] = useState(null);
  const [showPaywall, setShowPaywall] = useState(false);

  useEffect(() => {
    api.get(`/audit/${id}`).then(({ data }) => setAudit(data));
  }, [id]);

  useEffect(() => {
    if (!audit) return;
    api.get('/audit').then(({ data }) => {
      const sameDomain = data
        .filter((a) => a.domain === audit.domain && a.id !== audit.id && a.score != null)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      if (sameDomain[0]) setPreviousScore(sameDomain[0].score);
    });
  }, [audit]);

  if (!audit) {
    return (
      <DashboardLayout maxWidth={1100}>
        <p>{t('common.loading')}</p>
      </DashboardLayout>
    );
  }

  const fixes = Array.isArray(audit.ai_recommendations) ? audit.ai_recommendations : [];
  const impactCounts = {
    high: fixes.filter((f) => f.severity === 'high').length,
    medium: fixes.filter((f) => f.severity === 'medium').length,
    low: fixes.filter((f) => f.severity === 'low').length,
  };
  const total = fixes.length || 1;
  const impactSegs = ['high', 'medium', 'low'].map((level) => ({
    level,
    pct: (impactCounts[level] / total) * 100,
  }));

  const tabFixes = fixes.filter((f) => f.category === tab);
  const activeFixes = severity === 'all' ? tabFixes : tabFixes.filter((f) => f.severity === severity);
  const delta = previousScore != null && audit.score != null ? audit.score - previousScore : null;

  return (
    <DashboardLayout maxWidth={1100}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.ringBox}>
            {delta != null && (
              <div className={styles.deltaBadge}>
                {delta >= 0 ? `+${delta}` : delta} {t('report.vsPrevious')}
              </div>
            )}
            <ScoreRing score={audit.score ?? 0} size={96} strokeWidth={9} colorMode="accent" />
          </div>
          <div>
            <h1 className={styles.domain}>{audit.domain.replace(/^https?:\/\//, '')}</h1>
            <div className={styles.auditDate}>
              {t('report.auditOf', { date: new Date(audit.completed_at || audit.created_at).toLocaleDateString(i18n.resolvedLanguage) })}
            </div>
          </div>
        </div>
        <div className={styles.actions}>
          <Button variant="secondary" onClick={() => setShowPaywall(true)}>
            {t('report.exportPdf')}
          </Button>
          <Button variant="secondary" onClick={() => navigate(`/history?domain=${encodeURIComponent(audit.domain)}`)}>
            {t('report.seeHistory')}
          </Button>
        </div>
      </div>

      <div className={styles.impactBarWrap}>
        <div className={styles.impactBar}>
          {impactSegs.map((seg) => (
            <div key={seg.level} style={{ height: '100%', width: `${seg.pct}%`, background: IMPACT_COLOR[seg.level] }} />
          ))}
        </div>
        <div className={styles.legend}>
          <div className={styles.legendItem}>
            <span className={styles.legendDot} style={{ background: IMPACT_COLOR.high }} />
            <span className={styles.legendCount}>{impactCounts.high}</span> {t('report.highImpact')}
          </div>
          <div className={styles.legendItem}>
            <span className={styles.legendDot} style={{ background: IMPACT_COLOR.medium }} />
            <span className={styles.legendCount}>{impactCounts.medium}</span> {t('report.mediumImpact')}
          </div>
          <div className={styles.legendItem}>
            <span className={styles.legendDot} style={{ background: IMPACT_COLOR.low }} />
            <span className={styles.legendCount}>{impactCounts.low}</span> {t('report.lowImpact')}
          </div>
        </div>
      </div>

      <div className={styles.tabsRow}>
        <SegmentedControl
          value={tab}
          onChange={(v) => {
            setTab(v);
            setExpandedId(null);
          }}
          options={CATEGORIES.map((c) => ({
            value: c,
            label: t(`report.tab${c.charAt(0).toUpperCase() + c.slice(1)}`),
          }))}
        />
      </div>

      <div className={styles.filtersRow}>
        <PillFilter
          value={severity}
          onChange={setSeverity}
          options={SEVERITIES.map((s) => {
            const count = s === 'all' ? tabFixes.length : tabFixes.filter((f) => f.severity === s).length;
            const label = s === 'all' ? t('report.filterAll') : t(`report.filter${s.charAt(0).toUpperCase() + s.slice(1)}`);
            return { value: s, label: `${label} (${count})` };
          })}
        />
      </div>

      <div className={styles.list}>
        {activeFixes.length === 0 ? (
          <div className={styles.emptyCard}>{t('report.emptyState')}</div>
        ) : (
          activeFixes.map((fix, i) => {
            const fixId = fix.id || `${tab}-${i}`;
            return (
              <FixCard
                key={fixId}
                fix={fix}
                index={i}
                expanded={expandedId === fixId}
                onToggle={() => setExpandedId(expandedId === fixId ? null : fixId)}
              />
            );
          })
        )}
      </div>

      {showPaywall && <PaywallModal onClose={() => setShowPaywall(false)} />}
    </DashboardLayout>
  );
}
