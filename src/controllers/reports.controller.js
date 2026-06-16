const reportsService = require('../services/reports.service');
const { sendSuccess } = require('../utils/response.utils');

// ── GET /reports/dashboard (GYM_HOST / BRANCH_MANAGER) ───────────────────────
const hostDashboard = async (req, res, next) => {
  try {
    const { year, month, packageId, paymentMethod, paymentStatus } = req.query;
    const hasFilter = year || month || packageId || paymentMethod || paymentStatus;
    const kpis = hasFilter
      ? await reportsService.hostDashboardFiltered(req.tenantDb, { year, month, packageId, paymentMethod, paymentStatus })
      : await reportsService.hostDashboard(req.tenantDb);
    return sendSuccess(res, kpis);
  } catch (err) {
    next(err);
  }
};

// ── GET /reports/monthly ──────────────────────────────────────────────────────
const monthlyBreakdown = async (req, res, next) => {
  try {
    const data = await reportsService.monthlyBreakdown(req.tenantDb, req.query);
    return sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
};

// ── GET /reports/monthly/export-pdf ──────────────────────────────────────────
const monthlyExportPdf = async (req, res, next) => {
  try {
    const data = await reportsService.monthlyBreakdown(req.tenantDb, req.query);
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 40 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="monthly-report-${data.period.year}-${String(data.period.month).padStart(2, '0')}.pdf"`
    );
    doc.pipe(res);

    doc.fontSize(18).text(
      `Monthly Report — ${data.period.year}/${String(data.period.month).padStart(2, '0')}`,
      { align: 'center' }
    );
    doc.moveDown();

    doc.fontSize(13).text('Revenue by Day', { underline: true });
    doc.moveDown(0.4);
    if (!data.revenueByDay.length) {
      doc.fontSize(11).text('No revenue data.');
    } else {
      data.revenueByDay.forEach((r) => {
        doc.fontSize(11).text(
          `  ${r.day} — PKR ${parseFloat(r.totalRevenue).toLocaleString()} (${r.count} payments)`
        );
      });
    }

    doc.moveDown();
    doc.fontSize(13).text('New Subscriptions by Day', { underline: true });
    doc.moveDown(0.4);
    if (!data.subscriptionsByDay.length) {
      doc.fontSize(11).text('No subscriptions.');
    } else {
      data.subscriptionsByDay.forEach((s) => {
        doc.fontSize(11).text(`  ${s.day} — ${s.count} subscription(s)`);
      });
    }

    doc.moveDown();
    doc.fontSize(13).text('Check-Ins by Day', { underline: true });
    doc.moveDown(0.4);
    if (!data.checkInsByDay.length) {
      doc.fontSize(11).text('No check-ins.');
    } else {
      data.checkInsByDay.forEach((c) => {
        doc.fontSize(11).text(`  ${c.day} — ${c.count} check-in(s)`);
      });
    }

    doc.end();
  } catch (err) {
    next(err);
  }
};

// ── GET /reports/monthly/print-layout ────────────────────────────────────────
const monthlyPrintLayout = async (req, res, next) => {
  try {
    const data = await reportsService.monthlyBreakdown(req.tenantDb, req.query);

    const rows = (arr, cols) =>
      arr.map((r) => `<tr>${cols.map((c) => `<td>${r[c] ?? ''}</td>`).join('')}</tr>`).join('');

    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>Monthly Report ${data.period.year}/${data.period.month}</title>
<style>
  body{font-family:Arial,sans-serif;padding:24px}
  h1,h2{color:#1a1a2e}
  table{border-collapse:collapse;width:100%;margin-bottom:24px}
  th,td{border:1px solid #ccc;padding:6px 10px;text-align:left}
  th{background:#f5f5f5}
  @media print{button{display:none}}
</style>
</head><body>
<h1>Monthly Report &mdash; ${data.period.year}/${String(data.period.month).padStart(2, '0')}</h1>
<h2>Revenue by Day</h2>
<table><thead><tr><th>Day</th><th>Total Revenue (PKR)</th><th>Payments</th></tr></thead><tbody>
${rows(data.revenueByDay, ['day', 'totalRevenue', 'count'])}
</tbody></table>
<h2>New Subscriptions by Day</h2>
<table><thead><tr><th>Day</th><th>Subscriptions</th></tr></thead><tbody>
${rows(data.subscriptionsByDay, ['day', 'count'])}
</tbody></table>
<h2>Check-Ins by Day</h2>
<table><thead><tr><th>Day</th><th>Check-Ins</th></tr></thead><tbody>
${rows(data.checkInsByDay, ['day', 'count'])}
</tbody></table>
<button onclick="window.print()">Print</button>
</body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (err) {
    next(err);
  }
};

// ── GET /admin/reports/platform (PLATFORM_ADMIN) ──────────────────────────────
const platformSummary = async (req, res, next) => {
  try {
    const summary = await reportsService.platformSummary();
    return sendSuccess(res, summary);
  } catch (err) {
    next(err);
  }
};

const yearlyRevenue = async (req, res, next) => {
  try {
    const data = await reportsService.yearlyRevenue(req.tenantDb, req.query.year);
    return sendSuccess(res, data);
  } catch (err) { next(err); }
};

const weeklyAttendance = async (req, res, next) => {
  try {
    const data = await reportsService.weeklyAttendance(req.tenantDb);
    return sendSuccess(res, data);
  } catch (err) { next(err); }
};

// ── GET /reports/branch/:branchId ────────────────────────────────────────────
const branchReport = async (req, res, next) => {
  try {
    const data = await reportsService.branchReport(req.tenantDb, req.params.branchId);
    return sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
};

module.exports = { hostDashboard, monthlyBreakdown, monthlyExportPdf, monthlyPrintLayout, platformSummary, yearlyRevenue, weeklyAttendance, branchReport };
