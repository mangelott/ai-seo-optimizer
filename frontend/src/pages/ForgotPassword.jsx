import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AuthLayout from '../components/layout/AuthLayout';
import Button from '../components/ui/Button';
import Input, { Label } from '../components/ui/Input';
import styles from './Login.module.css';

export default function ForgotPassword() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  function handleSubmit(e) {
    e.preventDefault();
    setSent(true);
  }

  return (
    <AuthLayout>
      <div className={styles.card} style={{ textAlign: 'center' }}>
        <div className={styles.mark} style={{ background: 'var(--accent-soft)', fontSize: 16 }}>
          ✉️
        </div>
        <h1 className={styles.title}>
          {t('auth.forgotTitle')} <span className={styles.accent}>{t('auth.forgotTitleAccent')}</span>
        </h1>
        <p className={styles.subtitle}>{t('auth.forgotSubtitle')}</p>

        {sent ? (
          <p style={{ fontSize: 14, color: 'var(--text)', marginTop: 24 }}>
            📬 {email}
          </p>
        ) : (
          <form onSubmit={handleSubmit} style={{ textAlign: 'left' }}>
            <Label style={{ marginTop: 20 }}>{t('auth.email')}</Label>
            <Input
              type="email"
              placeholder={t('auth.emailPlaceholder')}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <Button type="submit" full style={{ marginTop: 20 }}>
              {t('auth.forgotCta')}
            </Button>
          </form>
        )}

        <p className={styles.footer}>
          <Link to="/login" className={styles.footerLink}>
            {t('auth.backToLogin')}
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
}
