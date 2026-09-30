# Inventory Tracker

A local inventory tracker for reselling **trading cards, figures and art**. It runs on
your own computer. There's no account, no cloud and nothing to install beyond Python.
Your data is a single SQLite file plus a photos folder in `data/`.

## Run it

You need Python 3.9 or newer ([python.org](https://www.python.org/downloads/)). No other packages.

| OS | How |
|---|---|
| Windows | Double-click `start.bat` |
| macOS / Linux | `./start.sh` (or `python3 app.py`) |

Your browser opens at <http://127.0.0.1:8765>. Leave the terminal window open while
you use it, and press **Ctrl+C** to stop.

Options:

```
python3 app.py --port 9000          # use a different port
python3 app.py --data-dir D:\Inv    # keep data somewhere else (e.g. a synced folder)
python3 app.py --no-browser         # don't auto-open a browser
python3 app.py --host 0.0.0.0       # let phones/tablets on your Wi-Fi use it (no login, trusted networks only)
```

## Features

- **Three item types, each with its own fields**
  - Cards: set, card #, grader (PSA/BGS/CGC/SGC/TAG/Raw), grade, cert #
  - Figures: brand, line/series, packaging (sealed / opened / loose)
  - Art: artist, medium, dimensions, signed, edition
  - All items: condition, year, quantity, storage location, tags, notes, photo
- **Cost basis and profit.** Records total cost and inbound shipping, market value,
  list price and platform, then sale price, fees and outbound shipping. Net profit,
  ROI and days held are calculated for you.
- **Partial sales.** Selling 1 of a lot of 4 splits the row, gives the sold part its
  share of the cost, and leaves the rest in stock.
- **Statuses:** In stock, Listed, Sold, and Personal collection (kept out of aging reports).
- **Dashboard:** stock count and invested amount, estimated value, revenue, net profit
  and ROI, average days to sell, monthly profit chart, breakdowns by category and by
  platform, and a list of items unsold for 90+ days.
- **Search and filter** by name, SKU, set, artist, tags and more. Sort by clicking a column.
- **SKUs are generated automatically** (`CRD-00001`, `FIG-00002`, `ART-00003`), or
  you can type your own.
- **Photos.** Attach one per item. Images are shrunk automatically so they don't
  take much disk space.
- **CSV export/import** for spreadsheets or bulk entry, plus a one-click database **Backup**.
- Light and dark themes, and a layout that works on a phone.

## Money fields

All money fields are **totals for the row**. If you bought 3 copies for $30, enter
quantity 3 and cost 30.

`Profit = sale price − cost − shipping in − fees − shipping out`

Estimated stock value uses market value if you've entered one, otherwise list price,
otherwise cost.

## Bulk import from a spreadsheet

Click **Export CSV** to get the column layout (it works even when the tracker is
empty). Only `name` and `category` (`card`, `figure` or `art`) are required. Rows
whose `id` matches an existing item update that item, and all other rows are added
as new items. Amounts like `$1,200.50` and dates like `3/15/2024` are accepted.

## Backups

Everything lives in the `data/` folder next to `app.py`:

- `data/inventory.db` holds all your items
- `data/photos/` holds item photos

To back up, copy that folder, or click **Backup** in the app to download the database.
To move to a new computer, copy the whole project folder including `data/`.

## Development

```
python3 -m unittest discover -s tests
```

`app.py` is the server and database (standard library only). `static/` is the web UI
in plain HTML, CSS and JavaScript, with no build step.
