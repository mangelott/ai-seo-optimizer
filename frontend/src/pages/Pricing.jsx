import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import PublicHeader from '../components/layout/PublicHeader';
import Button from '../components/ui/Button';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import styles from './Pricing.module.css';

const PRICES = {
  free: { monthly: '0€', annual: '0€' },
  starter: { monthly: '19€', annual: '15€' },
  pro: { monthly: '49€', annual: '39€' },
  agency: { monthly: '149€', annual: '119€' },
};

const ORDER = ['free', 'starter', 'pro', 'agency'];

export default function Pricing() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [billing, setBilling] = useState('annual');
  const plans = t('pricing.plans', { returnObjects: true });
  const isAnnual = billing === 'annual';

  return (
    <div>
      <PublicHeader />
      <div className={styles.wrap}>
        <h1 className={styles.title}>{t('pricing.title')}</h1>
        <p className={styles.subtitle}>{t('pricing.subtitle')}</p>

        <div className={styles.toggle}>
          <SegmentedControl
            value={billing}
            onChange={setBilling}
            options={[
              { value: 'monthly', label: t('pricing.monthly') },
              {
                value: 'annual',
                label: (
                  <>
                    {t('pricing.annual')} <span style={{ color: 'var(--success)', fontWeight: 700 }}>{t('pricing.annualDiscount')}</span>
                  </>
                ),
              },
            ]}
          />
        </div>

        <div className={styles.grid}>
          {ORDER.map((key) => {
            const plan = plans[key];
            const highlight = key === 'pro';
            const isFree = key === 'free';
            return (
              <div key={key} className={`${styles.card} ${highlight ? styles.cardHighlight : ''}`}>
                {highlight && <div className={styles.popularTag}>{t('pricing.mostPopular')}</div>}
                <div className={styles.planName}>{plan.name}</div>
                <div className={styles.tagline}>{plan.tagline}</div>
                <div className={styles.priceRow}>
                  <span className={styles.price}>{PRICES[key][billing]}</span>
                  {!isFree && <span className={styles.priceSuffix}>{t('landing.perMonth')}</span>}
                </div>
                <div className={styles.billingNote}>
                  {isFree ? t('pricing.foreverFree') : isAnnual ? t('pricing.billedAnnually') : t('pricing.billedMonthly')}
                </div>
                <Button
                  variant={highlight ? 'primary' : 'secondary'}
                  full
                  style={{ marginTop: 20 }}
                  onClick={() => navigate('/register')}
                >
                  {plan.cta}
                </Button>
                <div className={styles.features}>
                  {plan.features.map((f) => (
                    <div className={styles.feature} key={f}>
                      <span className={styles.check}>✓</span>
                      <span className={styles.featureText}>{f}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
