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
| **Shooting photos on your phone** | Windows: double-click `start-phone.bat` · Mac/Linux: `./start.sh --phone` |

Your browser opens at <http://127.0.0.1:8765>. Leave the terminal window open while
you use it, and press **Ctrl+C** to stop.

Options:

```
python3 app.py --port 9000          # use a different port
python3 app.py --data-dir D:\Inv    # keep data somewhere else (e.g. a synced folder)
python3 app.py --no-browser         # don't auto-open a browser
python3 app.py --phone              # let your phone connect over Wi-Fi to take photos (trusted networks only)
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
- **Photos.** Attach as many as you like per item (front, back, corners…). See
  [Taking photos](#taking-photos) below.
- **Whatnot helpers.** Each item has a **Listing kit** with a ready-made title and
  description you can copy, plus its photos. Recording a Whatnot sale estimates the
  fees automatically.
- **WhatsApp sharing.** Post one item, or your whole available-stock list, to a
  WhatsApp chat or group in a couple of taps.
- **CSV export/import** for spreadsheets or bulk entry, plus a one-click database **Backup**.
- Light and dark themes, and a layout that works on a phone.

## Taking photos

Photos are usually the slowest part of listing. The **Photos** tab is built to speed
that up.

**1. Shoot straight from your phone.** Start the tracker with `start-phone.bat` or
`./start.sh --phone`. The address to open on your phone (for example
`http://192.168.1.20:8765`) appears in the terminal and at the top of the Photos tab.
Your phone must be on the same Wi-Fi. Photos you take go straight into the right item,
so there's nothing to transfer. Use "Add to Home Screen" in your phone's browser to
open it like an app.

> Phone mode lets anything on your network open the tracker while it's running, and
> there's no password. Only use it on your home or shop Wi-Fi.

**2. Work through the photo queue.** The queue shows each unsold item that has no photos
yet, ordered by storage location so you can go shelf by shelf. It shows the item's name,
SKU and location. Tap **Take photo** as many times as you need, then **Next item**.

**3. Or shoot a whole batch, then match.** Drop a folder of photos onto
**Bulk upload & match**:
- Files named after a SKU attach to that item automatically. `CRD-00001.jpg`,
  `CRD-00001-back.jpg` and `crd-00001_2.png` all go to CRD-00001.
- Any other photos appear as thumbnails. Tap to select some, then attach them to an
  item, or use **New item from selected** to create a new item from them (handy when
  new stock comes in).

Each item's first photo is its cover. Click ★ on any photo to make it the cover.
Photos are shrunk to 1600px on upload so they stay small. **Download all (.zip)**
saves an item's photos as `SKU-1.jpg`, `SKU-2.jpg` and so on.

## Listing on Whatnot

Open **Listing** on any item (or **Listing kit** in the Photos queue or on the edit
screen) to get:

- **Photos to save.** On your phone, press and hold a photo and choose **Save to
  Photos**. It lands in your camera roll, ready to pick in the Whatnot app. On a
  computer, download the .zip for Whatnot's Seller Hub.
- **A title and description** built from the item's details, each with a **Copy**
  button. Edit them first if you like.
- **Your price, cost, and the estimated Whatnot fees** at that price.

When you record a sale on Whatnot, fees are filled in automatically:
8% commission plus 2.9% + $0.30 payment processing. That's Whatnot's standard rate;
some categories are lower, such as electronics and coins. Processing is also charged
on the shipping and tax the buyer pays, so check your payout and adjust the fees if
needed. The rates are at the top of `static/app.js` (`WHATNOT_FEES`).

The tracker doesn't create Whatnot listings for you. Whatnot's API isn't open to new
sellers, and its bulk CSV upload needs photos hosted at public web links.

## Sharing on WhatsApp

- **One item:** open its **Listing** kit and tap **Share to WhatsApp**. You get a post
  with the title, price, details and a `Ref: SKU` line, so buyers can tell you which
  one they mean. Pick the chat or group and press send.
  - If your browser can share files (Chrome on Windows, Safari on Mac, or a phone
    using the tracker on the same computer), the photos are attached too.
  - Otherwise WhatsApp opens with the text filled in, and you attach the photos from
    your camera roll. Save them there first with the listing kit.
- **Stock list:** on the Inventory tab, filter to what you want to advertise (say, all
  unsold cards) and click **Share on WhatsApp**. You get one tidy message grouped into
  cards, figures and art, with prices and SKUs, ready to edit and post to your buyers'
  group.

WhatsApp doesn't offer a way for apps to post into groups or Status automatically. The
unofficial tools that do it break WhatsApp's rules and get numbers banned. So the
tracker writes the post and you tap send.

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
