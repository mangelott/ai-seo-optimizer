import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Badge from './ui/Badge';
import Button from './ui/Button';
import buttonStyles from './ui/Button.module.css';
import { severityLabelKey } from '../lib/severity';
import styles from './FixCard.module.css';

const SEVERITY_BORDER = {
  high: 'var(--danger)',
  medium: 'var(--warning-strong)',
  low: 'var(--text-faint)',
};

export default function FixCard({ fix, index, expanded, onToggle }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const severity = fix.severity || 'low';
  const title = fix.title || fix.issue || '';

  function handleCopy(e) {
    e.stopPropagation();
    navigator.clipboard.writeText(fix.snippet || fix.suggestedFix || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className={styles.row} style={{ borderLeft: `4px solid ${SEVERITY_BORDER[severity]}` }}>
      <div className={styles.header} onClick={onToggle}>
        <div className={styles.headerLeft}>
          <span className={styles.index}>{String(index + 1).padStart(2, '0')}</span>
          <Badge variant={`${severity}Solid`}>{t(severityLabelKey(severity))}</Badge>
          <Badge variant="category">{t(`report.tab${fix.category.charAt(0).toUpperCase() + fix.category.slice(1)}`)}</Badge>
          <span className={styles.title}>{title}</span>
        </div>
        <span className={styles.chevron}>{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div className={styles.expandBox}>
          {fix.what && (
            <div>
              <div className={styles.label}>{t('report.what')}</div>
              <p className={styles.text}>{fix.what}</p>
            </div>
          )}
          {fix.why && (
            <div>
              <div className={styles.label}>{t('report.why')}</div>
              <p className={styles.text}>{fix.why}</p>
            </div>
          )}

          <div className={styles.compareGrid}>
            <div className={styles.compareBox} style={{ background: 'var(--danger-soft)' }}>
              <div className={styles.label}>{t('report.currentValue')}</div>
              <div className={styles.compareValue}>{fix.currentValue ?? '—'}</div>
            </div>
            <span className={styles.arrow}>→</span>
            <div className={styles.compareBox} style={{ background: 'var(--success-soft)' }}>
              <div className={styles.label}>{t('report.suggestedFix')}</div>
              <div className={styles.compareValue}>{fix.suggestedFix ?? '—'}</div>
            </div>
          </div>

          {fix.snippet && (
            <div>
              <div className={styles.label}>{t('report.snippet')}</div>
              <pre className={styles.codeBlock}>{fix.snippet}</pre>
            </div>
          )}

          <div className={styles.actions}>
            <Button
              size="sm"
              variant={copied ? 'success' : 'primary'}
              onClick={handleCopy}
            >
              {copied ? t('report.copied') : t('report.copyFix')}
            </Button>
            <button className={buttonStyles.base} disabled style={{ background: 'transparent', color: 'var(--text-faint)', border: '1px solid var(--border)', cursor: 'not-allowed', fontSize: 14, padding: '10px 16px' }}>
              {t('report.autoFix')}{' '}
              <span className={buttonStyles.comingSoonTag}>{t('report.comingSoon')}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
