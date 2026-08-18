import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Badge from './ui/Badge';
import Button from './ui/Button';
import Input from './ui/Input';
import buttonStyles from './ui/Button.module.css';
import { severityLabelKey } from '../lib/severity';
import styles from './FixCard.module.css';

const SEVERITY_BORDER = {
  high: 'var(--danger)',
  medium: 'var(--warning-strong)',
  low: 'var(--text-faint)',
};

export default function FixCard({ fix, index, expanded, onToggle, autoFixAvailable, onApply }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [candidates, setCandidates] = useState(null);
  const [manualPath, setManualPath] = useState('');
  const severity = fix.severity || 'low';
  const title = fix.title || fix.issue || '';
  const autoFixEligible = !!(fix.wpField || fix.sourceSearchText);

  function handleCopy(e) {
    e.stopPropagation();
    navigator.clipboard.writeText(fix.snippet || fix.suggestedFix || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  async function runApply(filePath) {
    setApplying(true);
    setApplyError('');
    try {
      await onApply(filePath);
      setCandidates(null);
    } catch (err) {
      if (err?.candidates) {
        setCandidates(err.candidates);
        setApplyError(err.message || t('report.autoFixError'));
      } else {
        setApplyError(t('report.autoFixError'));
      }
    } finally {
      setApplying(false);
    }
  }

  function handleApply(e) {
    e.stopPropagation();
    runApply();
  }

  function handlePickCandidate(e, path) {
    e.stopPropagation();
    runApply(path);
  }

  function handleManualSubmit(e) {
    e.stopPropagation();
    if (manualPath.trim()) runApply(manualPath.trim());
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
            {fix.prUrl ? (
              <a className={styles.prLink} href={fix.prUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                {t('report.autoFixPrOpened')}
              </a>
            ) : fix.applied ? (
              <span className={styles.appliedTag}>{t('report.autoFixApplied')}</span>
            ) : autoFixEligible && autoFixAvailable ? (
              <Button size="sm" variant="secondary" onClick={handleApply} disabled={applying}>
                {applying ? t('report.autoFixApplying') : t('report.autoFix')}
              </Button>
            ) : (
              <button className={buttonStyles.base} disabled style={{ background: 'transparent', color: 'var(--text-faint)', border: '1px solid var(--border)', cursor: 'not-allowed', fontSize: 14, padding: '10px 16px' }}>
                {t('report.autoFix')}{' '}
                <span className={buttonStyles.comingSoonTag}>
                  {autoFixEligible ? t('report.autoFixSetupNeeded') : t('report.comingSoon')}
                </span>
              </button>
            )}
          </div>
          {applyError && <p className={styles.applyError}>{applyError}</p>}
          {candidates && (
            <div className={styles.candidatePicker} onClick={(e) => e.stopPropagation()}>
              {candidates.length > 0 && (
                <div className={styles.candidateList}>
                  {candidates.map((path) => (
                    <button
                      key={path}
                      type="button"
                      className={styles.candidateBtn}
                      onClick={(e) => handlePickCandidate(e, path)}
                      disabled={applying}
                    >
                      {path}
                    </button>
                  ))}
                </div>
              )}
              <div className={styles.manualPathRow}>
                <Input
                  placeholder={t('report.autoFixManualPathPlaceholder')}
                  value={manualPath}
                  onChange={(e) => setManualPath(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
                <Button size="sm" variant="secondary" onClick={handleManualSubmit} disabled={applying || !manualPath.trim()}>
                  {t('report.autoFixApplyToFile')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
