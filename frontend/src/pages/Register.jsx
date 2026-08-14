import { useState } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api, { API_BASE_URL } from '../api/client';
import AuthLayout from '../components/layout/AuthLayout';
import Button from '../components/ui/Button';
import Input, { Label } from '../components/ui/Input';
import styles from './Login.module.css';

export default function Register() {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const scanId = searchParams.get('scanId');
  const scanDomain = searchParams.get('domain');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/auth/register', { name, email, password, scanId: scanId || undefined });
      const { data } = await api.post('/auth/login', { email, password });
      localStorage.setItem('token', data.token);
      navigate(scanId ? `/quick-scan/${scanId}` : '/dashboard');
    } catch (err) {
      setError(err.response?.data?.error || t('auth.registrationFailed'));
    }
  }

  return (
    <AuthLayout>
      <div className={styles.card} style={{ width: 400 }}>
        <div className={styles.header}>
          <div className={styles.mark}>↑</div>
          <h1 className={styles.title}>
            {t('auth.registerTitle')} <span className={styles.accent}>{t('auth.registerTitleAccent')}</span>
          </h1>
        </div>

        {scanDomain && (
          <div className={styles.scanBanner}>
            <span>🔎</span>
            <span>
              {t('auth.scanContext')} <strong>{scanDomain}</strong>
            </span>
          </div>
        )}

        <Button
          variant="secondary"
          full
          type="button"
          onClick={() => {
            const url = new URL(`${API_BASE_URL}/auth/google`);
            if (scanId) url.searchParams.set('state', scanId);
            window.location.href = url.toString();
          }}
        >
          {t('auth.continueWithGoogle')}
        </Button>

        <div className={styles.divider}>
          <div className={styles.dividerLine} />
          <span className={styles.dividerText}>{t('common.or')}</span>
          <div className={styles.dividerLine} />
        </div>

        <form onSubmit={handleSubmit}>
          <div className={styles.field}>
            <Label>{t('auth.name')}</Label>
            <Input placeholder={t('auth.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className={styles.field}>
            <Label>{t('auth.email')}</Label>
            <Input
              type="email"
              placeholder={t('auth.emailPlaceholder')}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className={styles.field}>
            <Label>{t('auth.password')}</Label>
            <Input
              type="password"
              placeholder={t('auth.passwordMin')}
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 16 }}>
            <input type="checkbox" required style={{ marginTop: 3 }} />
            <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{t('auth.termsAgree')}</span>
          </label>
          {error && <p className={styles.error} style={{ marginTop: 12 }}>{error}</p>}
          <Button type="submit" full style={{ marginTop: 20 }}>
            {t('auth.registerCta')}
          </Button>
        </form>

        <p className={styles.footer}>
          {t('auth.haveAccount')}{' '}
          <Link to="/login" className={styles.footerLink}>
            {t('auth.loginCta')}
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
}
