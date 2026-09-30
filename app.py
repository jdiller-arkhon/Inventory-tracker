#!/usr/bin/env python3
"""Reseller Inventory Tracker.

A small local web app for tracking trading cards, figures and art for resale.
Uses only the Python standard library: data lives in a SQLite file and the UI
is served to your browser from this machine.

    python3 app.py            # then open http://127.0.0.1:8765
"""

import argparse
import base64
import csv
import io
import json
import mimetypes
import re
import socket
import sqlite3
import sys
import tempfile
import threading
import uuid
import webbrowser
import zipfile
from datetime import date, datetime, timedelta
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
MAX_BODY = 25 * 1024 * 1024

CATEGORIES = ("card", "figure", "art")
STATUSES = ("in_stock", "listed", "sold", "personal")
SKU_PREFIX = {"card": "CRD", "figure": "FIG", "art": "ART"}
PHOTO_TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}

# Editable columns and their types. Money fields are totals for the row (lot).
FIELDS = {
    "sku": "text",
    "category": "text",
    "name": "text",
    "status": "text",
    "quantity": "int",
    "condition": "text",
    "year": "text",
    # Cards
    "set_name": "text",
    "card_number": "text",
    "grader": "text",
    "grade": "text",
    "cert_number": "text",
    # Figures
    "brand": "text",
    "series": "text",
    "packaging": "text",
    # Art
    "artist": "text",
    "medium": "text",
    "dimensions": "text",
    "signed": "text",
    "edition": "text",
    # Purchase
    "cost": "money",
    "shipping_in": "money",
    "purchase_date": "date",
    "purchase_source": "text",
    # Listing
    "market_value": "money",
    "list_price": "money",
    "listed_platform": "text",
    "listed_date": "date",
    "listing_url": "text",
    # Sale
    "sale_price": "money",
    "sale_date": "date",
    "sale_platform": "text",
    "fees": "money",
    "shipping_out": "money",
    # Misc
    "location": "text",
    "tags": "text",
    "notes": "text",
}
SALE_FIELDS = ("sale_price", "sale_date", "sale_platform", "fees", "shipping_out")
SQL_TYPES = {"text": "TEXT", "int": "INTEGER", "money": "REAL", "date": "TEXT"}
SORTABLE = set(FIELDS) | {"id", "created_at", "updated_at", "total_cost", "profit", "days_held"}
SEARCH_FIELDS = ("name", "sku", "set_name", "card_number", "brand", "series", "artist",
                 "tags", "notes", "location", "cert_number", "purchase_source")


class ValidationError(Exception):
    pass


# --------------------------------------------------------------------------- #
# Value parsing
# --------------------------------------------------------------------------- #

def parse_money(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return round(float(value), 2)
    text = str(value).strip().replace("$", "").replace(",", "")
    if text == "":
        return None
    try:
        return round(float(text), 2)
    except ValueError:
        raise ValidationError(f"'{value}' is not a valid amount")


def parse_int(value):
    if value is None or str(value).strip() == "":
        return None
    try:
        return int(float(str(value).strip()))
    except ValueError:
        raise ValidationError(f"'{value}' is not a whole number")


def parse_date(value):
    if value is None or str(value).strip() == "":
        return None
    text = str(value).strip()
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%Y/%m/%d"):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    raise ValidationError(f"'{value}' is not a valid date (use YYYY-MM-DD)")


PARSERS = {
    "text": lambda v: (str(v).strip() or None) if v is not None else None,
    "int": parse_int,
    "money": parse_money,
    "date": parse_date,
}


def clean_fields(data, partial=False):
    """Validate and normalise user supplied fields."""
    out = {}
    for key, kind in FIELDS.items():
        if key not in data:
            continue
        try:
            out[key] = PARSERS[kind](data[key])
        except ValidationError as exc:
            raise ValidationError(f"{key.replace('_', ' ')}: {exc}")

    if not partial or "category" in out:
        cat = (out.get("category") or "").lower()
        if cat not in CATEGORIES:
            raise ValidationError("category must be one of: " + ", ".join(CATEGORIES))
        out["category"] = cat
    if not partial or "name" in out:
        if not out.get("name"):
            raise ValidationError("name is required")
    if "status" in out or not partial:
        status = (out.get("status") or "in_stock").lower().replace(" ", "_")
        if status not in STATUSES:
            raise ValidationError("status must be one of: " + ", ".join(STATUSES))
        out["status"] = status
    if "quantity" in out or not partial:
        qty = out.get("quantity")
        qty = 1 if qty is None else qty
        if qty < 1:
            raise ValidationError("quantity must be at least 1")
        out["quantity"] = qty
    return out


# --------------------------------------------------------------------------- #
# Database
# --------------------------------------------------------------------------- #

class Inventory:
    def __init__(self, data_dir):
        self.data_dir = Path(data_dir)
        self.photo_dir = self.data_dir / "photos"
        self.photo_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = self.data_dir / "inventory.db"
        self.lock = threading.Lock()
        self._migrate()

    def connect(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _migrate(self):
        with self.connect() as conn:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS items ("
                " id INTEGER PRIMARY KEY AUTOINCREMENT,"
                " photo TEXT,"
                " created_at TEXT NOT NULL,"
                " updated_at TEXT NOT NULL)"
            )
            existing = {r["name"] for r in conn.execute("PRAGMA table_info(items)")}
            for key, kind in FIELDS.items():
                if key not in existing:
                    conn.execute(f"ALTER TABLE items ADD COLUMN {key} {SQL_TYPES[kind]}")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_items_status ON items(status)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_items_category ON items(category)")
            conn.execute(
                "CREATE TABLE IF NOT EXISTS photos ("
                " id INTEGER PRIMARY KEY AUTOINCREMENT,"
                " item_id INTEGER NOT NULL,"
                " filename TEXT NOT NULL,"
                " position INTEGER NOT NULL DEFAULT 0,"
                " created_at TEXT NOT NULL)"
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_photos_item ON photos(item_id)")
            # Older versions stored a single photo on the item row.
            conn.execute(
                "INSERT INTO photos (item_id, filename, position, created_at)"
                " SELECT id, photo, 0, updated_at FROM items WHERE photo IS NOT NULL AND photo != ''"
            )
            conn.execute("UPDATE items SET photo = NULL WHERE photo IS NOT NULL")

    # -- helpers ----------------------------------------------------------- #

    @staticmethod
    def _now():
        return datetime.now().isoformat(timespec="seconds")

    @staticmethod
    def decorate(row, photos=()):
        item = dict(row)
        item.pop("photo", None)
        total_cost = (item.get("cost") or 0) + (item.get("shipping_in") or 0)
        item["total_cost"] = round(total_cost, 2)
        item["profit"] = None
        if item.get("status") == "sold" and item.get("sale_price") is not None:
            item["profit"] = round(
                item["sale_price"] - total_cost - (item.get("fees") or 0) - (item.get("shipping_out") or 0), 2
            )
        item["days_held"] = None
        if item.get("purchase_date"):
            try:
                start = date.fromisoformat(item["purchase_date"])
                end = date.fromisoformat(item["sale_date"]) if item.get("status") == "sold" and item.get("sale_date") else date.today()
                item["days_held"] = (end - start).days
            except ValueError:
                pass
        item["photos"] = [{"id": p["id"], "url": f"/photos/{p['filename']}"} for p in photos]
        item["photo_count"] = len(item["photos"])
        item["photo_url"] = item["photos"][0]["url"] if item["photos"] else None
        return item

    @staticmethod
    def _photo_rows(conn, item_id=None):
        """Photo rows grouped by item id, cover photo first."""
        sql = "SELECT * FROM photos"
        args = ()
        if item_id is not None:
            sql += " WHERE item_id = ?"
            args = (item_id,)
        grouped = {}
        for row in conn.execute(sql + " ORDER BY item_id, position, id", args):
            grouped.setdefault(row["item_id"], []).append(dict(row))
        return grouped

    def _decorated(self, conn, item_id):
        row = self._get(conn, item_id)
        return self.decorate(row, self._photo_rows(conn, item_id).get(item_id, [])) if row else None

    @staticmethod
    def _apply_status_defaults(fields, current=None):
        status = fields.get("status", (current or {}).get("status"))
        today = date.today().isoformat()
        merged = dict(current or {}, **fields)
        if status == "listed" and not merged.get("listed_date"):
            fields["listed_date"] = today
        if status == "sold" and not merged.get("sale_date"):
            fields["sale_date"] = today
        return fields

    def _insert(self, conn, fields):
        now = self._now()
        fields = dict(fields, created_at=now, updated_at=now)
        cols = ", ".join(fields)
        marks = ", ".join("?" for _ in fields)
        cur = conn.execute(f"INSERT INTO items ({cols}) VALUES ({marks})", list(fields.values()))
        item_id = cur.lastrowid
        if not fields.get("sku"):
            sku = f"{SKU_PREFIX[fields['category']]}-{item_id:05d}"
            conn.execute("UPDATE items SET sku = ? WHERE id = ?", (sku, item_id))
        return item_id

    def _update(self, conn, item_id, fields):
        if not fields:
            return
        fields = dict(fields, updated_at=self._now())
        sets = ", ".join(f"{k} = ?" for k in fields)
        conn.execute(f"UPDATE items SET {sets} WHERE id = ?", [*fields.values(), item_id])

    def _get(self, conn, item_id):
        row = conn.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
        return dict(row) if row else None

    # -- CRUD -------------------------------------------------------------- #

    def list(self, q=None, category=None, status=None, sort="updated_at", order="desc", photos=None):
        where, args = [], []
        if photos == "missing":
            where.append("id NOT IN (SELECT item_id FROM photos)")
        elif photos == "has":
            where.append("id IN (SELECT item_id FROM photos)")
        if category in CATEGORIES:
            where.append("category = ?")
            args.append(category)
        if status == "unsold":
            where.append("status != 'sold'")
        elif status in STATUSES:
            where.append("status = ?")
            args.append(status)
        if q:
            for term in q.split():
                like = f"%{term}%"
                where.append("(" + " OR ".join(f"{f} LIKE ?" for f in SEARCH_FIELDS) + ")")
                args.extend([like] * len(SEARCH_FIELDS))
        sql = "SELECT * FROM items"
        if where:
            sql += " WHERE " + " AND ".join(where)
        with self.connect() as conn:
            photo_rows = self._photo_rows(conn)
            items = [self.decorate(r, photo_rows.get(r["id"], [])) for r in conn.execute(sql, args)]
        sort = sort if sort in SORTABLE else "updated_at"
        reverse = order != "asc"
        with_val = [i for i in items if i.get(sort) not in (None, "")]
        without = [i for i in items if i.get(sort) in (None, "")]
        key = (lambda i: str(i[sort]).lower()) if FIELDS.get(sort) == "text" else (lambda i: i[sort])
        with_val.sort(key=key, reverse=reverse)
        return with_val + without

    def get(self, item_id):
        with self.connect() as conn:
            return self._decorated(conn, item_id)

    def create(self, data):
        fields = self._apply_status_defaults(clean_fields(data))
        with self.lock, self.connect() as conn:
            item_id = self._insert(conn, fields)
        return self.get(item_id)

    def update(self, item_id, data):
        fields = clean_fields(data, partial=True)
        with self.lock, self.connect() as conn:
            current = self._get(conn, item_id)
            if not current:
                return None
            self._update(conn, item_id, self._apply_status_defaults(fields, current))
        return self.get(item_id)

    def delete(self, item_id):
        with self.lock, self.connect() as conn:
            current = self._get(conn, item_id)
            if not current:
                return False
            filenames = [r["filename"] for r in conn.execute("SELECT filename FROM photos WHERE item_id = ?", (item_id,))]
            conn.execute("DELETE FROM photos WHERE item_id = ?", (item_id,))
            conn.execute("DELETE FROM items WHERE id = ?", (item_id,))
            for filename in filenames:
                self._remove_photo_if_unused(conn, filename)
        return True

    def sell(self, item_id, data):
        """Mark some or all of a lot as sold. Partial sales split the row and
        allocate cost proportionally."""
        sale = clean_fields({k: data.get(k) for k in SALE_FIELDS if k in data}, partial=True)
        if sale.get("sale_price") is None:
            raise ValidationError("sale price is required")
        sale.setdefault("sale_date", None)
        sale["sale_date"] = sale["sale_date"] or date.today().isoformat()
        with self.lock, self.connect() as conn:
            item = self._get(conn, item_id)
            if not item:
                return None
            if item["status"] == "sold":
                raise ValidationError("item is already sold")
            have = item["quantity"] or 1
            qty = parse_int(data.get("quantity")) or have
            if qty < 1 or qty > have:
                raise ValidationError(f"quantity sold must be between 1 and {have}")
            if qty == have:
                self._update(conn, item_id, dict(sale, status="sold"))
                return self._decorated(conn, item_id)

            share = qty / have
            split = {}
            for key in ("cost", "shipping_in", "market_value"):
                if item.get(key) is not None:
                    split[key] = round(item[key] * share, 2)
            remaining = {k: round(item[k] - v, 2) for k, v in split.items()}
            remaining["quantity"] = have - qty
            self._update(conn, item_id, remaining)

            new_row = {k: item.get(k) for k in FIELDS}
            new_row.update(**split, **sale, quantity=qty, status="sold")
            new_id = self._insert(conn, new_row)
            # The sold part keeps the lot's photos (files are shared, not copied).
            conn.execute(
                "INSERT INTO photos (item_id, filename, position, created_at)"
                " SELECT ?, filename, position, created_at FROM photos WHERE item_id = ?",
                (new_id, item_id),
            )
            return self._decorated(conn, new_id)

    # -- photos ------------------------------------------------------------ #

    @staticmethod
    def _decode_image(data_url):
        match = re.match(r"^data:(image/[a-z+]+);base64,(.+)$", data_url or "", re.S)
        if not match or match.group(1) not in PHOTO_TYPES:
            raise ValidationError("photo must be a JPEG, PNG, WebP or GIF image")
        try:
            raw = base64.b64decode(match.group(2), validate=True)
        except ValueError:
            raise ValidationError("photo data is not valid base64")
        return raw, PHOTO_TYPES[match.group(1)]

    def add_photos(self, item_id, images):
        """Append one or more photos (data URLs) to an item."""
        if isinstance(images, str):
            images = [images]
        if not images:
            raise ValidationError("no photos supplied")
        decoded = [self._decode_image(img) for img in images]
        with self.lock, self.connect() as conn:
            if not self._get(conn, item_id):
                return None
            last = conn.execute("SELECT MAX(position) FROM photos WHERE item_id = ?", (item_id,)).fetchone()[0]
            position = -1 if last is None else last
            for raw, ext in decoded:
                position += 1
                filename = f"{uuid.uuid4().hex}.{ext}"
                (self.photo_dir / filename).write_bytes(raw)
                conn.execute(
                    "INSERT INTO photos (item_id, filename, position, created_at) VALUES (?, ?, ?, ?)",
                    (item_id, filename, position, self._now()),
                )
            conn.execute("UPDATE items SET updated_at = ? WHERE id = ?", (self._now(), item_id))
            return self._decorated(conn, item_id)

    def delete_photo(self, item_id, photo_id):
        with self.lock, self.connect() as conn:
            row = conn.execute("SELECT * FROM photos WHERE id = ? AND item_id = ?", (photo_id, item_id)).fetchone()
            if not row:
                return None
            conn.execute("DELETE FROM photos WHERE id = ?", (photo_id,))
            self._remove_photo_if_unused(conn, row["filename"])
            return self._decorated(conn, item_id)

    def set_cover(self, item_id, photo_id):
        with self.lock, self.connect() as conn:
            row = conn.execute("SELECT * FROM photos WHERE id = ? AND item_id = ?", (photo_id, item_id)).fetchone()
            if not row:
                return None
            first = conn.execute("SELECT MIN(position) FROM photos WHERE item_id = ?", (item_id,)).fetchone()[0]
            conn.execute("UPDATE photos SET position = ? WHERE id = ?", (first - 1, photo_id))
            return self._decorated(conn, item_id)

    def photos_zip(self, item_id):
        """All of an item's photos named SKU-1.jpg, SKU-2.jpg… ready for a listing."""
        item = self.get(item_id)
        if not item:
            return None, None
        base = re.sub(r"[^\w-]+", "_", item.get("sku") or f"item-{item_id}")
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
            for n, photo in enumerate(item["photos"], start=1):
                path = self.photo_path(photo["url"].rsplit("/", 1)[-1])
                if path:
                    zf.write(path, f"{base}-{n}{path.suffix}")
        return buf.getvalue(), base

    def match_filenames(self, names):
        """Match photo filenames to items by SKU, e.g. 'CRD-00001.jpg' or
        'crd-00001_back.jpg'. Returns {filename: item summary or None}."""
        with self.connect() as conn:
            rows = [dict(r) for r in conn.execute("SELECT id, sku, name, status FROM items WHERE sku IS NOT NULL AND sku != ''")]
        rows.sort(key=lambda r: -len(r["sku"]))  # prefer the longest (most specific) SKU
        result = {}
        for name in names:
            stem = Path(str(name)).stem.strip().upper()
            found = None
            for row in rows:
                sku = row["sku"].upper()
                if stem == sku or (stem.startswith(sku) and stem[len(sku)] in "-_ .(#"):
                    found = row
                    break
            result[name] = found
        return result

    def _remove_photo_if_unused(self, conn, filename):
        if not filename:
            return
        in_use = conn.execute("SELECT 1 FROM photos WHERE filename = ? LIMIT 1", (filename,)).fetchone()
        if not in_use:
            (self.photo_dir / filename).unlink(missing_ok=True)

    def photo_path(self, filename):
        if not re.fullmatch(r"[\w-]+\.(jpg|png|webp|gif)", filename):
            return None
        path = self.photo_dir / filename
        return path if path.is_file() else None

    # -- stats ------------------------------------------------------------- #

    def stats(self):
        items = self.list()
        unsold = [i for i in items if i["status"] != "sold"]
        sold = [i for i in items if i["status"] == "sold"]

        def value_of(i):
            if i.get("market_value") is not None:
                return i["market_value"]
            if i.get("list_price") is not None:
                return i["list_price"]
            return i["total_cost"]

        def summarize(unsold_rows, sold_rows):
            cost_sold = sum(i["total_cost"] for i in sold_rows)
            profit = sum(i["profit"] or 0 for i in sold_rows)
            held = [i["days_held"] for i in sold_rows if i["days_held"] is not None]
            return {
                "inventory_items": len(unsold_rows),
                "inventory_units": sum(i["quantity"] or 1 for i in unsold_rows),
                "inventory_cost": round(sum(i["total_cost"] for i in unsold_rows), 2),
                "inventory_value": round(sum(value_of(i) for i in unsold_rows), 2),
                "listed_items": sum(1 for i in unsold_rows if i["status"] == "listed"),
                "sold_items": len(sold_rows),
                "revenue": round(sum(i["sale_price"] or 0 for i in sold_rows), 2),
                "fees": round(sum((i["fees"] or 0) + (i["shipping_out"] or 0) for i in sold_rows), 2),
                "profit": round(profit, 2),
                "roi": round(profit / cost_sold * 100, 1) if cost_sold else None,
                "avg_days_to_sell": round(sum(held) / len(held)) if held else None,
            }

        by_category = {
            cat: summarize([i for i in unsold if i["category"] == cat], [i for i in sold if i["category"] == cat])
            for cat in CATEGORIES
        }

        # Last 12 months of sales, oldest first.
        months = []
        cursor = date.today().replace(day=1)
        for _ in range(12):
            months.append(cursor.strftime("%Y-%m"))
            cursor = (cursor - timedelta(days=1)).replace(day=1)
        months.reverse()
        monthly = {m: {"month": m, "sold": 0, "revenue": 0.0, "profit": 0.0} for m in months}
        for i in sold:
            key = (i.get("sale_date") or "")[:7]
            if key in monthly:
                monthly[key]["sold"] += 1
                monthly[key]["revenue"] = round(monthly[key]["revenue"] + (i["sale_price"] or 0), 2)
                monthly[key]["profit"] = round(monthly[key]["profit"] + (i["profit"] or 0), 2)

        platforms = {}
        for i in sold:
            name = i.get("sale_platform") or "Unspecified"
            p = platforms.setdefault(name, {"platform": name, "sold": 0, "revenue": 0.0, "profit": 0.0})
            p["sold"] += 1
            p["revenue"] = round(p["revenue"] + (i["sale_price"] or 0), 2)
            p["profit"] = round(p["profit"] + (i["profit"] or 0), 2)

        aging = sorted(
            (i for i in unsold if i["status"] != "personal" and (i["days_held"] or 0) >= 90),
            key=lambda i: -i["days_held"],
        )
        return {
            "totals": summarize(unsold, sold),
            "by_category": by_category,
            "monthly": list(monthly.values()),
            "platforms": sorted(platforms.values(), key=lambda p: -p["revenue"]),
            "aging": [{k: i[k] for k in ("id", "sku", "name", "category", "status", "days_held", "total_cost")} for i in aging[:10]],
            "aging_count": len(aging),
            "missing_photos": sum(1 for i in unsold if i["status"] != "personal" and not i["photo_count"]),
        }

    # -- CSV / backup ------------------------------------------------------ #

    def export_csv(self):
        buf = io.StringIO()
        writer = csv.writer(buf)
        columns = ["id", *FIELDS, "profit", "created_at", "updated_at"]
        writer.writerow(columns)
        for item in self.list(sort="id", order="asc"):
            writer.writerow(["" if item.get(c) is None else item.get(c) for c in columns])
        return buf.getvalue()

    def import_csv(self, text):
        reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
        if not reader.fieldnames or not {"name", "category"} <= {f.strip().lower() for f in reader.fieldnames}:
            raise ValidationError("CSV must have at least 'name' and 'category' columns")
        created = updated = 0
        errors = []
        for line, raw in enumerate(reader, start=2):
            row = {(k or "").strip().lower(): v for k, v in raw.items()}
            if not any((v or "").strip() for v in row.values() if isinstance(v, str)):
                continue
            data = {k: v for k, v in row.items() if k in FIELDS}
            try:
                item_id = parse_int(row.get("id"))
                if item_id and self.get(item_id):
                    self.update(item_id, data)
                    updated += 1
                else:
                    self.create(data)
                    created += 1
            except ValidationError as exc:
                errors.append(f"Row {line}: {exc}")
        return {"created": created, "updated": updated, "errors": errors}

    def backup_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "backup.db"
            src = self.connect()
            dst = sqlite3.connect(target)
            try:
                src.backup(dst)
            finally:
                dst.close()
                src.close()
            return target.read_bytes()


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #

ITEM_ROUTE = re.compile(r"^/api/items/(\d+)(?:/(sell|photos|photos\.zip)(?:/(\d+)(?:/(cover))?)?)?$")


def lan_addresses():
    """Best guess at this machine's addresses on the local network."""
    addrs = set()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.254.254.254", 1))  # no packets are sent; this just picks the outbound interface
            addrs.add(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            addrs.add(info[4][0])
    except OSError:
        pass
    return sorted(a for a in addrs if not a.startswith("127."))


class Handler(BaseHTTPRequestHandler):
    inventory: Inventory = None
    phone_urls: list = []
    server_version = "InventoryTracker/1.0"

    def log_message(self, fmt, *args):
        if "--verbose" in sys.argv:
            super().log_message(fmt, *args)

    # -- responses --------------------------------------------------------- #

    def send_body(self, status, body, content_type, extra_headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, data, status=HTTPStatus.OK):
        self.send_body(status, json.dumps(data).encode(), "application/json")

    def send_error_json(self, status, message):
        self.send_json({"error": message}, status)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ValidationError("request is too large")
        return self.rfile.read(length) if length else b""

    def read_json(self):
        body = self.read_body()
        if not body:
            return {}
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            raise ValidationError("invalid JSON")
        if not isinstance(data, dict):
            raise ValidationError("expected a JSON object")
        return data

    def serve_file(self, path):
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        self.send_body(HTTPStatus.OK, path.read_bytes(), ctype)

    # -- routing ----------------------------------------------------------- #

    def handle_safely(self, fn):
        try:
            fn()
        except ValidationError as exc:
            self.send_error_json(HTTPStatus.BAD_REQUEST, str(exc))
        except Exception as exc:  # pragma: no cover - last-resort guard
            self.log_error("Unhandled error: %r", exc)
            self.send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, "internal error")

    def do_GET(self):
        self.handle_safely(self._get)

    do_HEAD = do_GET

    def do_POST(self):
        self.handle_safely(self._post)

    def do_PUT(self):
        self.handle_safely(self._put)

    def do_DELETE(self):
        self.handle_safely(self._delete)

    def _get(self):
        url = urlparse(self.path)
        path = url.path
        inv = self.inventory
        if path == "/api/items":
            qs = {k: v[0] for k, v in parse_qs(url.query).items()}
            return self.send_json(inv.list(qs.get("q"), qs.get("category"), qs.get("status"),
                                           qs.get("sort", "updated_at"), qs.get("order", "desc"), qs.get("photos")))
        if path == "/api/info":
            return self.send_json({"phone_urls": self.phone_urls})
        if path == "/api/stats":
            return self.send_json(inv.stats())
        if path == "/api/meta":
            return self.send_json({"categories": CATEGORIES, "statuses": STATUSES, "fields": FIELDS})
        if path == "/api/export.csv":
            stamp = date.today().isoformat()
            return self.send_body(HTTPStatus.OK, inv.export_csv().encode("utf-8-sig"), "text/csv; charset=utf-8",
                                  {"Content-Disposition": f'attachment; filename="inventory-{stamp}.csv"'})
        if path == "/api/backup":
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            return self.send_body(HTTPStatus.OK, inv.backup_bytes(), "application/octet-stream",
                                  {"Content-Disposition": f'attachment; filename="inventory-backup-{stamp}.db"'})
        m = ITEM_ROUTE.match(path)
        if m and not m.group(2):
            item = inv.get(int(m.group(1)))
            return self.send_json(item) if item else self.send_error_json(HTTPStatus.NOT_FOUND, "item not found")
        if m and m.group(2) == "photos.zip" and not m.group(3):
            data, base = inv.photos_zip(int(m.group(1)))
            if data is None:
                return self.send_error_json(HTTPStatus.NOT_FOUND, "item not found")
            return self.send_body(HTTPStatus.OK, data, "application/zip",
                                  {"Content-Disposition": f'attachment; filename="{base}-photos.zip"'})
        if path.startswith("/photos/"):
            photo = inv.photo_path(unquote(path[len("/photos/"):]))
            return self.serve_file(photo) if photo else self.send_error_json(HTTPStatus.NOT_FOUND, "photo not found")
        if path.startswith("/api/"):
            return self.send_error_json(HTTPStatus.NOT_FOUND, "not found")

        rel = "index.html" if path in ("", "/") else unquote(path).lstrip("/")
        target = (STATIC_DIR / rel).resolve()
        if STATIC_DIR in target.parents and target.is_file():
            return self.serve_file(target)
        return self.send_error_json(HTTPStatus.NOT_FOUND, "not found")

    def _post(self):
        path = urlparse(self.path).path
        inv = self.inventory
        if path == "/api/items":
            return self.send_json(inv.create(self.read_json()), HTTPStatus.CREATED)
        if path == "/api/import":
            text = self.read_body().decode("utf-8", errors="replace")
            return self.send_json(inv.import_csv(text))
        if path == "/api/photos/match":
            names = self.read_json().get("names") or []
            if not isinstance(names, list):
                raise ValidationError("names must be a list")
            return self.send_json(inv.match_filenames([str(n) for n in names]))
        m = ITEM_ROUTE.match(path)
        route = (m.group(2), bool(m.group(3)), m.group(4)) if m else None
        if route == ("sell", False, None):
            result = inv.sell(int(m.group(1)), self.read_json())
        elif route == ("photos", False, None):
            body = self.read_json()
            result = inv.add_photos(int(m.group(1)), body.get("images") or body.get("data"))
        elif route == ("photos", True, "cover"):
            result = inv.set_cover(int(m.group(1)), int(m.group(3)))
        else:
            return self.send_error_json(HTTPStatus.NOT_FOUND, "not found")
        return self.send_json(result) if result else self.send_error_json(HTTPStatus.NOT_FOUND, "item not found")

    def _put(self):
        m = ITEM_ROUTE.match(urlparse(self.path).path)
        if not m or m.group(2):
            return self.send_error_json(HTTPStatus.NOT_FOUND, "not found")
        item = self.inventory.update(int(m.group(1)), self.read_json())
        return self.send_json(item) if item else self.send_error_json(HTTPStatus.NOT_FOUND, "item not found")

    def _delete(self):
        m = ITEM_ROUTE.match(urlparse(self.path).path)
        if not m:
            return self.send_error_json(HTTPStatus.NOT_FOUND, "not found")
        item_id = int(m.group(1))
        if m.group(2) == "photos" and m.group(3) and not m.group(4):
            item = self.inventory.delete_photo(item_id, int(m.group(3)))
            return self.send_json(item) if item else self.send_error_json(HTTPStatus.NOT_FOUND, "photo not found")
        if m.group(2):
            return self.send_error_json(HTTPStatus.NOT_FOUND, "not found")
        if self.inventory.delete(item_id):
            return self.send_json({"deleted": item_id})
        return self.send_error_json(HTTPStatus.NOT_FOUND, "item not found")


def make_server(data_dir, host="127.0.0.1", port=8765):
    handler = type("BoundHandler", (Handler,), {"inventory": Inventory(data_dir)})
    server = ThreadingHTTPServer((host, port), handler)
    bound_port = server.server_address[1]
    if host in ("0.0.0.0", ""):
        handler.phone_urls = [f"http://{ip}:{bound_port}" for ip in lan_addresses()]
    elif not host.startswith("127.") and host != "localhost":
        handler.phone_urls = [f"http://{host}:{bound_port}"]
    return server


def main():
    parser = argparse.ArgumentParser(description="Reseller inventory tracker for cards, figures and art.")
    parser.add_argument("--host", default="127.0.0.1", help="address to bind (default 127.0.0.1, this machine only)")
    parser.add_argument("--port", type=int, default=8765, help="port to listen on (default 8765)")
    parser.add_argument("--data-dir", default=str(BASE_DIR / "data"), help="where the database and photos are stored")
    parser.add_argument("--phone", action="store_true",
                        help="allow phones/tablets on your Wi-Fi to connect (same as --host 0.0.0.0)")
    parser.add_argument("--no-browser", action="store_true", help="don't open a browser window on start")
    parser.add_argument("--verbose", action="store_true", help="log every request")
    args = parser.parse_args()
    if args.phone:
        args.host = "0.0.0.0"

    try:
        server = make_server(args.data_dir, args.host, args.port)
    except OSError as exc:
        sys.exit(f"Could not start on {args.host}:{args.port} ({exc}). Try --port with a different number.")

    shown_host = "127.0.0.1" if args.host in ("0.0.0.0", "") else args.host
    url = f"http://{shown_host}:{args.port}"
    print(f"Inventory tracker running at {url}")
    print(f"Data folder: {Path(args.data_dir).resolve()}")
    phone_urls = server.RequestHandlerClass.phone_urls
    if phone_urls:
        print("On your phone (same Wi-Fi), open: " + "  or  ".join(phone_urls))
        print("Anyone on this network can reach the tracker while it runs - use trusted networks only.")
    print("Press Ctrl+C to stop.")
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
