# Paisa — Personal Finance & UPI Expense Dashboard

A responsive expense tracker with a local Node.js API and SQLite database.

## Run locally

1. Install Node.js 22.5 or later.
2. Open this folder in a terminal and run `npm install`.
3. Run `npm start`.
4. Open `http://127.0.0.1:8011`.

The server creates `data/paisa.sqlite` automatically. It listens only on this computer and does not need an internet connection to save expenses. Keep the server running while using the app.

On the first launch, existing expenses and budgets from this browser are imported into SQLite once. The original browser data is left untouched.

The database contains personal financial data. Keep the server local; it has no sign-in and should not be exposed to the internet. To back up your data, stop the server and copy `data/paisa.sqlite`.

## Install as an app

- **Desktop Chrome or Edge:** open the site and select **Install app**, or use the browser's install icon/menu.
- **Android:** open the site in Chrome and choose **Install app** or **Add to Home screen**.
- **iPhone/iPad:** open the site in Safari, tap **Share**, then **Add to Home Screen**.

The installed PWA uses the same local-only backend as the browser. Because it listens only on this computer, installing the app on a separate phone does not connect that phone to this database. Shared phone/computer data requires a secured cloud backend; do not expose this local server publicly.

## Import an SBI UPI statement

1. Download an SBI account statement as a CSV or text-based PDF.
2. In Paisa, choose the statement under **Import UPI transactions**.
3. Review the detected UPI debits, choose a category for each, and import them.

CSV and PDF contents are read on this device; only reviewed transactions are sent to the local Paisa server. Scanned/image-only and password-protected PDFs are not supported. Re-importing the same statement skips rows already added. The importer does not connect to SBI or monitor payments live; download and import a fresh statement to add recent transactions.

Use [the clearly marked synthetic demo PDF](./samples/sample-sbi-upi-statement.pdf) to try the importer. It contains two UPI debits, one UPI credit, and one non-UPI debit so you can verify filtering. All sample names, dates, references, and amounts are invented; the PDF is not an official SBI statement.

## Features

- Record cash and UPI expenses with a date, category, and description.
- Set category budgets for each month.
- Import UPI debit transactions from an SBI CSV or text-based PDF after reviewing and categorizing them.
- Skip statement transactions already imported, so importing the same statement again does not duplicate them.
- Get in-app reminders at 80% of a category budget and when it is exceeded.
- Optionally enable browser notifications; these require permission and appear while Paisa is open.
- Review a monthly category-by-category expense-versus-budget report and download it as CSV.
- Review monthly totals, available budget, and cash-versus-UPI spending.
- View a category spending chart and filter the expense list by payment method.
- Work offline after the app shell has loaded once.
- Save expenses and budgets to the local SQLite database.

The installed app can load its interface offline after it has been opened once, but the local Node server must still be running to read or save data.
