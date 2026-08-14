import { PDFDownloadLink } from '@react-pdf/renderer';
import ReportPDF from './ReportPDF';
import buttonStyles from './ui/Button.module.css';

export default function PdfExportLink({ audit, appName, loadingLabel, label }) {
  return (
    <PDFDownloadLink
      document={<ReportPDF audit={audit} appName={appName} />}
      fileName={`${audit.domain.replace(/^https?:\/\//, '')}-seo-report.pdf`}
      className={`${buttonStyles.base} ${buttonStyles.secondary}`}
      style={{ textDecoration: 'none' }}
    >
      {({ loading }) => (loading ? loadingLabel : label)}
    </PDFDownloadLink>
  );
}
