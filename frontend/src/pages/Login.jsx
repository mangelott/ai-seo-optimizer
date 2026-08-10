import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client';
import AuthLayout from '../components/layout/AuthLayout';
import Button from '../components/ui/Button';
import Input, { Label } from '../components/ui/Input';
import styles from './Login.module.css';

export default function Login() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    try {
      const { data } = await api.post('/auth/login', { email, password });
      localStorage.setItem('token', data.token);
      navigate('/dashboard');
    } catch {
      setError(t('auth.invalidCredentials'));
    }
  }

  return (
    <AuthLayout>
      <div className={styles.card}>
        <div className={styles.header}>
          <div className={styles.mark}>↑</div>
          <h1 className={styles.title}>
            {t('auth.loginTitle')} <span className={styles.accent}>{t('auth.loginTitleAccent')}</span>
          </h1>
          <p className={styles.subtitle}>{t('auth.loginSubtitle')}</p>
        </div>

        <Button variant="secondary" full type="button">
          {t('auth.continueWithGoogle')}
        </Button>

        <div className={styles.divider}>
          <div className={styles.dividerLine} />
          <span className={styles.dividerText}>{t('common.or')}</span>
          <div className={styles.dividerLine} />
        </div>

        <form onSubmit={handleSubmit}>
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
            <div className={styles.rowBetween}>
              <Label>{t('auth.password')}</Label>
              <Link to="/forgot-password" className={styles.forgotLink}>
                {t('auth.forgotPassword')}
              </Link>
            </div>
            <Input
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && <p className={styles.error}>{error}</p>}
          <Button type="submit" full style={{ marginTop: 4 }}>
            {t('auth.loginCta')}
          </Button>
        </form>

        <p className={styles.footer}>
          {t('auth.noAccount')}{' '}
          <Link to="/register" className={styles.footerLink}>
            {t('auth.createFreeAccount')}
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
}
