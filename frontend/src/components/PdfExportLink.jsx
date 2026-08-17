import { PDFDownloadLink } from '@react-pdf/renderer';
import ReportPDF from './ReportPDF';
import buttonStyles from './ui/Button.module.css';

export default function PdfExportLink({ audit, appName, loadingLabel, label, brandColor, logoUrl }) {
  return (
    <PDFDownloadLink
      document={<ReportPDF audit={audit} appName={appName} brandColor={brandColor} logoUrl={logoUrl} />}
      fileName={`${audit.domain.replace(/^https?:\/\//, '')}-seo-report.pdf`}
      className={`${buttonStyles.base} ${buttonStyles.secondary}`}
      style={{ textDecoration: 'none' }}
    >
      {({ loading }) => (loading ? loadingLabel : label)}
    </PDFDownloadLink>
  );
}
