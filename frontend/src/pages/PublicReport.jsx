import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import PublicHeader from '../components/layout/PublicHeader';
import Button from '../components/ui/Button';
import ReportBody from '../components/ReportBody';
import api from '../api/client';
import styles from './Report.module.css';

export default function PublicReport() {
  const { t } = useTranslation();
  const { token } = useParams();
  const [audit, setAudit] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    api
      .get(`/public/report/${token}`)
      .then(({ data }) => setAudit(data))
      .catch(() => setError(true));
  }, [token]);

  return (
    <div>
      <PublicHeader />
      <div className={styles.publicWrap}>
        <div className={styles.publicBanner}>
          <span>{t('report.publicBanner')}</span>
          <Link to="/register">
            <Button size="sm" variant="secondary">{t('report.publicCta')}</Button>
          </Link>
        </div>
        {error && <p>{t('report.noResultsYet')}</p>}
        {!error && !audit && <p>{t('common.loading')}</p>}
        {audit && <ReportBody audit={audit} />}
      </div>
    </div>
  );
}
