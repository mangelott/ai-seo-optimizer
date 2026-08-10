import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import DashboardLayout from '../components/layout/DashboardLayout';
import api from '../api/client';
import styles from './AuditProcessing.module.css';

const STEP_KEYS = ['step1', 'step2', 'step3', 'step4', 'step5'];
const ESTIMATED_MS = 30000;

export default function AuditProcessing() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const [domain, setDomain] = useState('');
  const [progress, setProgress] = useState(4);
  const startRef = useRef(Date.now());

  useEffect(() => {
    let cancelled = false;

    const tick = setInterval(() => {
      const elapsed = Date.now() - startRef.current;
      const pct = Math.min(96, Math.round((elapsed / ESTIMATED_MS) * 100));
      setProgress((p) => Math.max(p, pct));
    }, 400);

    async function poll() {
      try {
        const { data } = await api.get(`/audit/${id}`);
        setDomain(data.domain?.replace(/^https?:\/\//, '') || '');
        if (data.status === 'completed') {
          setProgress(100);
          if (!cancelled) setTimeout(() => navigate(`/audits/${id}`), 500);
          return;
        }
      } catch {
        // keep polling
      }
      if (!cancelled) setTimeout(poll, 2000);
    }
    poll();

    return () => {
      cancelled = true;
      clearInterval(tick);
    };
  }, [id, navigate]);

  const activeStepIndex = Math.min(STEP_KEYS.length - 1, Math.floor((progress / 100) * STEP_KEYS.length));

  return (
    <DashboardLayout>
      <div className={styles.wrap}>
        <h1 className={styles.title}>{t('processing.title', { domain })}</h1>
        <p className={styles.subtitle}>{t('processing.subtitle')}</p>

        <div className={styles.track}>
          <div className={styles.fill} style={{ width: `${progress}%` }} />
        </div>
        <div className={styles.pct}>{progress}%</div>

        <div className={styles.stepsCard}>
          {STEP_KEYS.map((key, i) => {
            const done = i < activeStepIndex || progress === 100;
            const active = i === activeStepIndex && progress < 100;
            return (
              <div className={styles.step} key={key}>
                {done ? (
                  <div className={styles.stepIconDone}>✓</div>
                ) : active ? (
                  <div className={styles.stepIconActive} />
                ) : (
                  <div className={styles.stepIconPending} />
                )}
                <span
                  style={{
                    fontSize: 14,
                    color: !done && !active ? 'var(--text-faint)' : 'var(--text)',
                    fontWeight: active ? 600 : 500,
                  }}
                >
                  {t(`processing.${key}`)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </DashboardLayout>
  );
}
