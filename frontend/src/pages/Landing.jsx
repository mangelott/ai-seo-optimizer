import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import PublicHeader from '../components/layout/PublicHeader';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import ScoreRing from '../components/ui/ScoreRing';
import api from '../api/client';
import { severityLabelKey } from '../lib/severity';
import styles from './Landing.module.css';

const BENEFITS = [
  { icon: '⚡', key: 'benefit1' },
  { icon: '🎯', key: 'benefit2' },
  { icon: '💬', key: 'benefit3' },
  { icon: '📊', key: 'benefit4' },
];

const PREVIEW_LEVELS = ['high', 'medium', 'low'];

export default function Landing() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function runScan(e) {
    e.preventDefault();
    if (!url.trim()) return;
    setLoading(true);
    setError('');
    const domain = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    try {
      const { data } = await api.post('/quick-scan', { domain });
      navigate(`/quick-scan/${data.scanId}?domain=${encodeURIComponent(domain)}`);
    } catch {
      setError(t('landing.scanError'));
    } finally {
      setLoading(false);
    }
  }

  const testimonials = t('landing.testimonials', { returnObjects: true });
  const logos = t('landing.logos', { returnObjects: true });
  const previewIssues = t('landing.previewIssues', { returnObjects: true });
  const plans = t('pricing.plans', { returnObjects: true });
  const pricingTeaser = [
    { key: 'free', name: t('landing.planFree'), price: '0€', period: t('landing.planForever') },
    { key: 'starter', name: plans.starter.name, price: '19€', period: t('landing.perMonth') },
    { key: 'pro', name: plans.pro.name, price: '49€', period: t('landing.perMonth') },
    { key: 'agency', name: plans.agency.name, price: '149€', period: t('landing.perMonth') },
  ];

  return (
    <div>
      <PublicHeader />

      <section className={styles.hero}>
        <div className={styles.heroLeft}>
          <span className={styles.eyebrow}>{t('landing.eyebrow')}</span>
          <h1 className={styles.h1}>
            {t('landing.titleLine1')}
            <br />
            <span className={styles.accent}>{t('landing.titleAccent')}</span>
          </h1>
          <p className={styles.subtitle}>{t('landing.subtitle')}</p>
          <form onSubmit={runScan} className={styles.scanBar}>
            <span className={styles.scanPrefix}>https://</span>
            <input
              className={styles.scanInput}
              placeholder={t('landing.scanPlaceholder')}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Button type="submit" disabled={loading}>
              {t('landing.scanCta')}
            </Button>
          </form>
          {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</p>}
          <p className={styles.scanNote}>{t('landing.scanNote')}</p>
        </div>
        <div className={styles.heroRight}>
          <div className={styles.previewCard}>
            <div className={styles.previewBadge}>{t('landing.previewBadge')}</div>
            <div className={styles.previewHeader}>
              <div className={styles.previewDomain}>
                <span className={styles.dot} />
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>loja-online.pt</span>
              </div>
              <span style={{ fontSize: 13, color: 'var(--text-faint)' }}>{t('landing.previewToday')}</span>
            </div>
            <div className={styles.previewRing}>
              <ScoreRing score={82} size={128} strokeWidth={12} colorMode="accent" labelSuffix="/ 100" />
            </div>
            <div className={styles.previewIssues}>
              {previewIssues.map((title, i) => (
                <div className={styles.previewIssueRow} key={i}>
                  <Badge variant={PREVIEW_LEVELS[i]}>{t(severityLabelKey(PREVIEW_LEVELS[i]))}</Badge>
                  <span style={{ fontSize: 13, color: 'var(--text)', flex: 1 }}>{title}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{t('landing.benefitsTitle')}</h2>
        <div className={styles.benefitsGrid}>
          {BENEFITS.map((b) => (
            <div key={b.key} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 24 }}>
              <div className={styles.benefitIcon}>{b.icon}</div>
              <h3 className={styles.benefitTitle}>{t(`landing.${b.key}Title`)}</h3>
              <p className={styles.benefitDesc}>{t(`landing.${b.key}Desc`)}</p>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.trustSection}>
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 24px' }}>
          <p className={styles.trustLabel}>{t('landing.trustedBy')}</p>
          <div className={styles.logos}>
            {logos.map((logo) => (
              <span className={styles.logo} key={logo}>{logo}</span>
            ))}
          </div>
          <div className={styles.featuredQuote}>
            <p className={styles.featuredQuoteText}>"{testimonials[0].quote}"</p>
            <div className={styles.avatarRow}>
              <div className={styles.avatar}>{testimonials[0].initials}</div>
              <div>
                <div className={styles.testimonialName}>{testimonials[0].name}</div>
                <div className={styles.testimonialRole}>{testimonials[0].role}</div>
              </div>
            </div>
          </div>
          <div className={styles.testimonialsGrid}>
            {testimonials.slice(1).map((tst) => (
              <div className={styles.testimonialCard} key={tst.name}>
                <p style={{ fontSize: 15, color: 'var(--text)', lineHeight: 1.6, margin: 0 }}>"{tst.quote}"</p>
                <div className={styles.avatarRow}>
                  <div className={`${styles.avatar} ${styles.avatarSm}`}>{tst.initials}</div>
                  <div>
                    <div className={styles.testimonialName}>{tst.name}</div>
                    <div className={styles.testimonialRole}>{tst.role}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className={styles.pricingSection}>
        <h2 className={styles.sectionTitle}>{t('landing.pricingTeaserTitle')}</h2>
        <p className={styles.pricingSubtitle}>{t('landing.pricingTeaserSubtitle')}</p>
        <div className={styles.pricingTeaserGrid}>
          {pricingTeaser.map((p) => (
            <div className={styles.teaserCard} key={p.key}>
              <div className={styles.teaserName}>{p.name}</div>
              <div className={styles.teaserPrice}>{p.price}</div>
              <div className={styles.teaserPeriod}>{p.period}</div>
            </div>
          ))}
        </div>
        <Link to="/pricing">
          <Button variant="secondary" style={{ marginTop: 32 }}>
            {t('landing.pricingTeaserCta')}
          </Button>
        </Link>
      </section>

      <section className={styles.ctaBand}>
        <div className={styles.ctaInner}>
          <h2 className={styles.ctaTitle}>{t('landing.ctaTitle')}</h2>
          <form onSubmit={runScan} className={styles.scanBar} style={{ marginTop: 32 }}>
            <span className={styles.scanPrefix}>https://</span>
            <input
              className={styles.scanInput}
              placeholder={t('landing.scanPlaceholder')}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Button type="submit" disabled={loading}>
              {t('landing.scanCta')}
            </Button>
          </form>
        </div>
      </section>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <div>
            <div className={styles.footerLogo}>
              <div style={{ width: 24, height: 24, borderRadius: 7, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 800, fontSize: 12 }}>↑</div>
              <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{t('common.appName')}</span>
            </div>
            <p className={styles.footerTagline}>{t('footer.tagline')}</p>
          </div>
          <div>
            <div className={styles.footerHead}>{t('footer.product')}</div>
            <div className={styles.footerLink}>{t('footer.features')}</div>
            <div className={styles.footerLink}>{t('footer.pricing')}</div>
            <div className={styles.footerLink}>{t('footer.changelog')}</div>
          </div>
          <div>
            <div className={styles.footerHead}>{t('footer.company')}</div>
            <div className={styles.footerLink}>{t('footer.about')}</div>
            <div className={styles.footerLink}>{t('footer.blog')}</div>
            <div className={styles.footerLink}>{t('footer.contact')}</div>
          </div>
          <div>
            <div className={styles.footerHead}>{t('footer.legal')}</div>
            <div className={styles.footerLink}>{t('footer.privacy')}</div>
            <div className={styles.footerLink}>{t('footer.terms')}</div>
          </div>
        </div>
      </footer>
    </div>
  );
}
