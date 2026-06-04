const mysql = require('mysql2');
const ExcelJS = require('exceljs');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const axios = require('axios');
require('dotenv').config();

const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10
});
const promiseDb = db.promise();

const exportDir = path.join(__dirname, 'exports');
if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

// Create old exports directory if not exists
const oldExportsDir = path.join(exportDir, 'old exports');
if (!fs.existsSync(oldExportsDir)) fs.mkdirSync(oldExportsDir, { recursive: true });

const excelFilename = 'transactions_latest.xlsx';
const pdfFilename = 'transactions_latest.pdf';
const excelPath = path.join(exportDir, excelFilename);
const pdfPath = path.join(exportDir, pdfFilename);

// Helper: move existing files to a timestamped folder inside 'old exports'
function archiveOldFiles() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const archiveFolder = path.join(oldExportsDir, timestamp);
    if (!fs.existsSync(archiveFolder)) fs.mkdirSync(archiveFolder, { recursive: true });

    if (fs.existsSync(excelPath)) {
        const dest = path.join(archiveFolder, excelFilename);
        fs.renameSync(excelPath, dest);
        console.log(`📦 Archived Excel: ${dest}`);
    }
    if (fs.existsSync(pdfPath)) {
        const dest = path.join(archiveFolder, pdfFilename);
        fs.renameSync(pdfPath, dest);
        console.log(`📦 Archived PDF: ${dest}`);
    }
}

function calculateFee(amount) { return (amount * 0.049) + 0.30; }

function formatDate(dateInput) {
    if (!dateInput) return 'N/A';
    let d = new Date(dateInput);
    if (isNaN(d.getTime())) {
        const match = String(dateInput).match(/(\d{4})-(\d{2})-(\d{2})/);
        if (match) d = new Date(match[1], match[2] - 1, match[3]);
        else return 'Invalid Date';
    }
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = String(d.getFullYear()).slice(-2);
    return `${day}/${month}/${year}`;
}

let cachedRateSAR = null, rateLastFetchedSAR = null;
let cachedRateEGP = null, rateLastFetchedEGP = null;

async function getUSDtoSAR() {
    const now = Date.now();
    if (cachedRateSAR && rateLastFetchedSAR && (now - rateLastFetchedSAR) < 60 * 60 * 1000) return cachedRateSAR;
    try {
        const response = await axios.get('https://api.exchangerate-api.com/v4/latest/USD');
        cachedRateSAR = response.data.rates.SAR;
        rateLastFetchedSAR = now;
        return cachedRateSAR;
    } catch (error) {
        console.error('Exchange rate fetch failed for SAR, using fallback 3.75');
        return 3.75;
    }
}

async function getUSDtoEGP() {
    const now = Date.now();
    if (cachedRateEGP && rateLastFetchedEGP && (now - rateLastFetchedEGP) < 60 * 60 * 1000) return cachedRateEGP;
    try {
        const response = await axios.get('https://api.exchangerate-api.com/v4/latest/USD');
        cachedRateEGP = response.data.rates.EGP;
        rateLastFetchedEGP = now;
        return cachedRateEGP;
    } catch (error) {
        console.error('Exchange rate fetch failed for EGP, using fallback 52.71');
        return 52.71;
    }
}

async function exportToExcelAndPDF() {
    try {
        // Archive previous files before generating new ones
        archiveOldFiles();

        const [rows] = await promiseDb.execute(`
            SELECT 
                t.id,
                u.email AS user_email,
                t.amount,
                t.status,
                t.user_ip,
                t.payer_name,
                t.payer_email,
                t.card_type,
                t.card_last4,
                t.created_at
            FROM transactions t
            JOIN users u ON t.user_id = u.id
            WHERE t.status = 'completed'
            ORDER BY t.created_at DESC
        `);

        let totalGross = 0, totalFees = 0, totalNet = 0;
        rows.forEach(row => {
            const amount = parseFloat(row.amount);
            const fee = calculateFee(amount);
            totalGross += amount;
            totalFees += fee;
            totalNet += (amount - fee);
        });
        const usdToSar = await getUSDtoSAR();
        const usdToEgp = await getUSDtoEGP();
        const totalNetSAR = (totalNet * usdToSar).toFixed(2);
        const totalFeesSAR = (totalFees * usdToSar).toFixed(2);
        const totalNetEGP = (totalNet * usdToEgp).toFixed(2);
        const totalFeesEGP = (totalFees * usdToEgp).toFixed(2);
        const completedCount = rows.length;

        // ========== EXCEL ==========
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Transactions');

        worksheet.columns = [
            { header: 'ID', key: 'id', width: 8 },
            { header: 'User Email', key: 'user_email', width: 28 },
            { header: 'Gross (USD)', key: 'amount', width: 12 },
            { header: 'Fee (USD)', key: 'fee', width: 12 },
            { header: 'Net (USD)', key: 'net', width: 12 },
            { header: 'Status', key: 'status', width: 10 },
            { header: 'User IP', key: 'user_ip', width: 15 },
            { header: 'Payer Name', key: 'payer_name', width: 20 },
            { header: 'Payer Email', key: 'payer_email', width: 25 },
            { header: 'Card Type', key: 'card_type', width: 12 },
            { header: 'Card Last 4', key: 'card_last4', width: 10 },
            { header: 'Date', key: 'created_at', width: 12 }
        ];

        function addBorders(row) {
            row.eachCell(cell => {
                cell.border = {
                    top: { style: 'thin' },
                    left: { style: 'thin' },
                    bottom: { style: 'thin' },
                    right: { style: 'thin' }
                };
            });
        }

        const headerRow = worksheet.getRow(1);
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF667eea' } };
        addBorders(headerRow);

        rows.forEach(row => {
            const amount = parseFloat(row.amount);
            const fee = calculateFee(amount);
            const net = amount - fee;
            const dataRow = worksheet.addRow({
                id: row.id,
                user_email: row.user_email,
                amount: amount.toFixed(2),
                fee: fee.toFixed(2),
                net: net.toFixed(2),
                status: row.status,
                user_ip: row.user_ip,
                payer_name: row.payer_name || 'N/A',
                payer_email: row.payer_email || 'N/A',
                card_type: row.card_type || 'N/A',
                card_last4: row.card_last4 || 'N/A',
                created_at: formatDate(row.created_at)
            });
            dataRow.getCell(5).font = { color: { argb: 'FF008000' }, bold: true };
            addBorders(dataRow);
        });

        worksheet.addRow({});

        const totalRow = worksheet.addRow([]);
        totalRow.getCell(1).value = 'TOTAL';
        totalRow.getCell(3).value = totalGross.toFixed(2);
        totalRow.getCell(4).value = totalFees.toFixed(2);
        totalRow.getCell(5).value = totalNet.toFixed(2);
        totalRow.font = { bold: true };
        totalRow.getCell(5).font = { color: { argb: 'FF008000' }, bold: true };
        totalRow.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCCFFCC' } };
        addBorders(totalRow);

        const sarRow = worksheet.addRow([]);
        sarRow.getCell(1).value = `Exchange rate: 1 USD = ${usdToSar} SAR`;
        sarRow.getCell(4).value = `Fees in SAR: ${totalFeesSAR}`;
        sarRow.getCell(5).value = `Net in SAR: ${totalNetSAR}`;
        sarRow.getCell(1).font = { bold: true };
        sarRow.getCell(4).font = { bold: true, color: { argb: 'FF008000' } };
        sarRow.getCell(5).font = { bold: true, color: { argb: 'FF008000' } };
        addBorders(sarRow);

        const egpRow = worksheet.addRow([]);
        egpRow.getCell(1).value = `Exchange rate: 1 USD = ${usdToEgp} EGP`;
        egpRow.getCell(4).value = `Fees in EGP: ${totalFeesEGP}`;
        egpRow.getCell(5).value = `Net in EGP: ${totalNetEGP}`;
        egpRow.getCell(1).font = { bold: true };
        egpRow.getCell(4).font = { bold: true, color: { argb: 'FF008000' } };
        egpRow.getCell(5).font = { bold: true, color: { argb: 'FF008000' } };
        addBorders(egpRow);

        worksheet.autoFilter = { from: 'A1', to: `L${rows.length + 4}` };
        worksheet.pageSetup = {
            orientation: 'landscape',
            fitToPage: true,
            fitToWidth: 1,
            fitToHeight: 0,
            paperSize: 9,
            horizontalCentered: true,
            verticalCentered: true
        };

        await workbook.xlsx.writeFile(excelPath);
        console.log(`✅ Excel saved: ${excelPath}`);

        // ========== PDF ==========
        const doc = new PDFDocument({ margin: 20, size: 'A4', layout: 'portrait' });
        const pdfStream = fs.createWriteStream(pdfPath);
        doc.pipe(pdfStream);

        doc.fontSize(12).text('Payment Transactions Report', { align: 'center' });
        doc.fontSize(8).text(`Generated on ${formatDate(new Date())}`, { align: 'center' });
        doc.moveDown(0.5);

        const startX = 20;
        let startY = doc.y;
        const rowHeight = 16;
        const fontSize = 8;
        const colWidths = [30, 120, 50, 50, 50, 50, 60];

        function drawRow(y, data, isHeader = false) {
            let x = startX;
            if (isHeader) doc.font('Helvetica-Bold');
            else doc.font('Helvetica');
            for (let i = 0; i < data.length; i++) {
                doc.fontSize(fontSize).text(data[i], x, y, { width: colWidths[i], align: 'left' });
                x += colWidths[i];
            }
            if (!isHeader) doc.font('Helvetica');
        }

        const headers = ['ID', 'User Email', 'Gross ($)', 'Fee ($)', 'Net ($)', 'Status', 'Date'];
        drawRow(startY, headers, true);
        startY += rowHeight;
        doc.moveTo(startX, startY).lineTo(startX + colWidths.reduce((a,b)=>a+b,0), startY).stroke();

        let currentY = startY;
        for (const row of rows) {
            if (currentY + rowHeight > doc.page.height - doc.page.margins.bottom) {
                doc.addPage();
                currentY = doc.y;
                drawRow(currentY, headers, true);
                currentY += rowHeight;
                doc.moveTo(startX, currentY).lineTo(startX + colWidths.reduce((a,b)=>a+b,0), currentY).stroke();
            }
            const amount = parseFloat(row.amount);
            const fee = calculateFee(amount);
            const net = amount - fee;
            const date = formatDate(row.created_at);
            drawRow(currentY, [
                row.id.toString(),
                row.user_email.substring(0, 25),
                `$${amount.toFixed(2)}`,
                `$${fee.toFixed(2)}`,
                `$${net.toFixed(2)}`,
                row.status,
                date
            ]);
            currentY += rowHeight;
        }

        const summaryY = currentY + 10;
        if (summaryY + 130 > doc.page.height - doc.page.margins.bottom) {
            doc.addPage();
            doc.y = doc.page.margins.top;
        } else {
            doc.y = summaryY;
        }
        doc.moveDown(0.5);
        doc.fontSize(10).text('Summary', { underline: true });
        doc.fontSize(8);
        doc.text(`Total Gross: $${totalGross.toFixed(2)}`);
        doc.text(`Total Fees (USD): $${totalFees.toFixed(2)}`);
        doc.text(`Total Fees (SAR): ${totalFeesSAR} SAR`);
        doc.text(`Total Fees (EGP): ${totalFeesEGP} EGP`);
        doc.fillColor('green').text(`Total Net (USD): $${totalNet.toFixed(2)}`).fillColor('black');
        doc.text(`Exchange rate: 1 USD = ${usdToSar} SAR`);
        doc.fillColor('green').text(`Total Net (SAR): ${totalNetSAR} SAR`).fillColor('black');
        doc.text(`Exchange rate: 1 USD = ${usdToEgp} EGP`);
        doc.fillColor('green').text(`Total Net (EGP): ${totalNetEGP} EGP`).fillColor('black');
        doc.text(`Completed transactions: ${completedCount}`);

        doc.moveDown(1.5);
        doc.fontSize(10);
        doc.text('Authorized Signature: _________________________', { align: 'left' });
        doc.moveDown(0.5);
        doc.text(`Date: _________________________ (${formatDate(new Date())})`, { align: 'left' });
        doc.moveDown(0.5);
        doc.fontSize(8);
        doc.fillColor('red').text('This report is generated electronically and is considered valid upon signature.', { align: 'left' });
        doc.fillColor('black');
        doc.end();

        await new Promise(resolve => pdfStream.on('finish', resolve));
        console.log(`✅ PDF saved: ${pdfPath}`);

        // ========== EMAIL ==========
        const transporter = nodemailer.createTransport({
            host: process.env.EMAIL_HOST,
            port: parseInt(process.env.EMAIL_PORT || '587'),
            secure: process.env.EMAIL_PORT === '465',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
            connectionTimeout: 10000,
            greetingTimeout: 10000,
            socketTimeout: 15000
        });

        try {
            await transporter.verify();
            await transporter.sendMail({
                from: `"WinCoD" <${process.env.EMAIL_USER}>`,
                to: process.env.EMAIL_TO,
                subject: `Transaction Export - ${formatDate(new Date())}`,
                text: `Total net (USD): $${totalNet.toFixed(2)}\nTotal net (SAR): ${totalNetSAR}\nTotal net (EGP): ${totalNetEGP}`,
                attachments: [
                    { filename: excelFilename, path: excelPath },
                    { filename: pdfFilename, path: pdfPath }
                ]
            });
            console.log(`📧 Email sent to ${process.env.EMAIL_TO}`);
        } catch (emailErr) {
            console.error('❌ Email sending failed (export files saved locally):', emailErr.message);
        }

        await promiseDb.end();
        console.log('Export completed successfully.');
    } catch (err) {
        console.error('❌ Export failed:', err);
        process.exit(1);
    }
}
exportToExcelAndPDF();