import { Document, Page, Text, View, Image, StyleSheet, Font } from '@react-pdf/renderer';

const COLORS = {
  text: '#1f2430',
  muted: '#6b7280',
  faint: '#9aa1ac',
  border: '#e5e7eb',
  accent: '#5b4fd6',
  accentSoft: '#eeecfc',
  danger: '#c0392b',
  dangerSoft: '#fbeae8',
  warning: '#b8860b',
  warningSoft: '#faf1dd',
  success: '#1e8e5a',
  successSoft: '#e6f5ee',
  codeBg: '#1f2430',
  codeText: '#e5e7eb',
};

const SEVERITY_COLOR = { high: COLORS.danger, medium: COLORS.warning, low: COLORS.faint };
const SEVERITY_SOFT = { high: COLORS.dangerSoft, medium: COLORS.warningSoft, low: '#f1f2f4' };

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 10, color: COLORS.text, fontFamily: 'Helvetica' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 },
  domain: { fontSize: 20, fontFamily: 'Helvetica-Bold' },
  meta: { fontSize: 9, color: COLORS.muted, marginTop: 2 },
  scoreBox: { alignItems: 'center', backgroundColor: COLORS.accentSoft, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 18 },
  scoreValue: { fontSize: 24, fontFamily: 'Helvetica-Bold', color: COLORS.accent },
  scoreLabel: { fontSize: 8, color: COLORS.muted },
  summaryRow: { flexDirection: 'row', gap: 16, marginBottom: 18 },
  summaryItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  summaryCount: { fontFamily: 'Helvetica-Bold' },
  summaryText: { color: COLORS.muted },
  categoryTitle: { fontSize: 13, fontFamily: 'Helvetica-Bold', marginTop: 14, marginBottom: 8 },
  card: { borderWidth: 1, borderColor: COLORS.border, borderRadius: 6, padding: 10, marginBottom: 8, breakInside: 'avoid' },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  index: { fontSize: 9, color: COLORS.faint, fontFamily: 'Courier' },
  badge: { fontSize: 8, fontFamily: 'Helvetica-Bold', paddingVertical: 2, paddingHorizontal: 6, borderRadius: 8, color: '#ffffff' },
  categoryTag: { fontSize: 8, backgroundColor: '#f1f2f4', color: COLORS.muted, paddingVertical: 2, paddingHorizontal: 6, borderRadius: 8 },
  cardTitle: { fontSize: 11, fontFamily: 'Helvetica-Bold', flex: 1 },
  label: { fontSize: 7, fontFamily: 'Helvetica-Bold', color: COLORS.faint, marginBottom: 2, letterSpacing: 0.5 },
  body: { fontSize: 9.5, color: COLORS.muted, marginBottom: 6, lineHeight: 1.4 },
  compareRow: { flexDirection: 'row', gap: 8, marginBottom: 6 },
  compareBox: { flex: 1, borderRadius: 6, padding: 8 },
  compareValue: { fontFamily: 'Courier', fontSize: 8.5, marginTop: 2 },
  codeBlock: { backgroundColor: COLORS.codeBg, color: COLORS.codeText, fontFamily: 'Courier', fontSize: 8.5, padding: 8, borderRadius: 6, marginTop: 2 },
  footer: { position: 'absolute', bottom: 20, left: 36, right: 36, fontSize: 8, color: COLORS.faint, flexDirection: 'row', justifyContent: 'space-between' },
});

const CATEGORY_LABELS = { technical: 'Technical', content: 'Content', keywords: 'Keywords', backlinks: 'Backlinks' };
const SEVERITY_LABELS = { high: 'High', medium: 'Medium', low: 'Low' };

export default function ReportPDF({ audit, appName = 'AI SEO Optimizer', brandColor, logoUrl }) {
  const accent = brandColor || COLORS.accent;
  const fixes = Array.isArray(audit.ai_recommendations) ? audit.ai_recommendations : [];
  const byCategory = ['technical', 'content', 'keywords', 'backlinks']
    .map((category) => ({ category, items: fixes.filter((f) => f.category === category) }))
    .filter((group) => group.items.length > 0);

  const counts = {
    high: fixes.filter((f) => f.severity === 'high').length,
    medium: fixes.filter((f) => f.severity === 'medium').length,
    low: fixes.filter((f) => f.severity === 'low').length,
  };

  const domain = (audit.domain || '').replace(/^https?:\/\//, '');
  const date = new Date(audit.completed_at || audit.created_at).toLocaleDateString();

  return (
    <Document title={`${domain} - SEO Report`}>
      <Page size="A4" style={styles.page} wrap>
        <View style={styles.headerRow}>
          <View>
            {logoUrl && <Image src={logoUrl} style={{ width: 110, maxHeight: 36, objectFit: 'contain', marginBottom: 8 }} />}
            <Text style={styles.domain}>{domain}</Text>
            <Text style={styles.meta}>Audit from {date}</Text>
          </View>
          <View style={[styles.scoreBox, { backgroundColor: brandColor ? `${brandColor}22` : COLORS.accentSoft }]}>
            <Text style={[styles.scoreValue, { color: accent }]}>{audit.score ?? '-'}</Text>
            <Text style={styles.scoreLabel}>/ 100</Text>
          </View>
        </View>

        <View style={styles.summaryRow}>
          <View style={styles.summaryItem}>
            <View style={[styles.dot, { backgroundColor: COLORS.danger }]} />
            <Text style={styles.summaryCount}>{counts.high}</Text>
            <Text style={styles.summaryText}>high impact</Text>
          </View>
          <View style={styles.summaryItem}>
            <View style={[styles.dot, { backgroundColor: COLORS.warning }]} />
            <Text style={styles.summaryCount}>{counts.medium}</Text>
            <Text style={styles.summaryText}>medium impact</Text>
          </View>
          <View style={styles.summaryItem}>
            <View style={[styles.dot, { backgroundColor: COLORS.faint }]} />
            <Text style={styles.summaryCount}>{counts.low}</Text>
            <Text style={styles.summaryText}>low impact</Text>
          </View>
        </View>

        {byCategory.map((group) => (
          <View key={group.category}>
            <Text style={styles.categoryTitle}>{CATEGORY_LABELS[group.category] || group.category}</Text>
            {group.items.map((fix, i) => (
              <View style={styles.card} key={fix.id || i} wrap={false}>
                <View style={styles.cardHeader}>
                  <Text style={styles.index}>{String(i + 1).padStart(2, '0')}</Text>
                  <Text style={[styles.badge, { backgroundColor: SEVERITY_COLOR[fix.severity] || COLORS.faint }]}>
                    {SEVERITY_LABELS[fix.severity] || fix.severity}
                  </Text>
                  <Text style={styles.categoryTag}>{CATEGORY_LABELS[fix.category] || fix.category}</Text>
                  <Text style={styles.cardTitle}>{fix.title || fix.issue}</Text>
                </View>

                {fix.what && (
                  <View>
                    <Text style={styles.label}>WHAT</Text>
                    <Text style={styles.body}>{fix.what}</Text>
                  </View>
                )}
                {fix.why && (
                  <View>
                    <Text style={styles.label}>WHY IT MATTERS</Text>
                    <Text style={styles.body}>{fix.why}</Text>
                  </View>
                )}

                <View style={styles.compareRow}>
                  <View style={[styles.compareBox, { backgroundColor: COLORS.dangerSoft }]}>
                    <Text style={styles.label}>CURRENT VALUE</Text>
                    <Text style={styles.compareValue}>{fix.currentValue || '-'}</Text>
                  </View>
                  <View style={[styles.compareBox, { backgroundColor: COLORS.successSoft }]}>
                    <Text style={styles.label}>SUGGESTED FIX</Text>
                    <Text style={styles.compareValue}>{fix.suggestedFix || '-'}</Text>
                  </View>
                </View>

                {fix.snippet && (
                  <View>
                    <Text style={styles.label}>SNIPPET</Text>
                    <Text style={styles.codeBlock}>{fix.snippet}</Text>
                  </View>
                )}
              </View>
            ))}
          </View>
        ))}

        <View style={styles.footer} fixed>
          <Text>{appName}</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
