import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Button from './ui/Button';
import styles from './PaywallModal.module.css';

export default function PaywallModal({ onClose }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.icon}>🚀</div>
        <h2 className={styles.title}>{t('paywall.title')}</h2>
        <p className={styles.subtitle}>{t('paywall.subtitle')}</p>

        <div className={styles.benefitsBox}>
          <div className={styles.benefitsTitle}>{t('paywall.withProTitle')}</div>
          <div className={styles.benefitsList}>
            <div className={styles.benefitItem}><span style={{ color: 'var(--success)' }}>✓</span> {t('paywall.benefit1')}</div>
            <div className={styles.benefitItem}><span style={{ color: 'var(--success)' }}>✓</span> {t('paywall.benefit2')}</div>
            <div className={styles.benefitItem}><span style={{ color: 'var(--success)' }}>✓</span> {t('paywall.benefit3')}</div>
          </div>
        </div>

        <div className={styles.actions}>
          <Button variant="secondary" style={{ flex: 1, justifyContent: 'center' }} onClick={onClose}>
            {t('paywall.notNow')}
          </Button>
          <Button style={{ flex: 1, justifyContent: 'center' }} onClick={() => navigate('/pricing')}>
            {t('paywall.upgrade')}
          </Button>
        </div>
      </div>
    </div>
  );
}
