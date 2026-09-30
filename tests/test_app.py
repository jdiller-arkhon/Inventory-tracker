import base64
import io
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zipfile
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import app  # noqa: E402

PNG_1PX = base64.b64encode(
    bytes.fromhex(
        "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
        "1f15c4890000000d49444154789c6360000002000100e221bc330000000049454e44ae426082"
    )
).decode()


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.inv = app.Inventory(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_create_assigns_sku_and_defaults(self):
        item = self.inv.create({"category": "card", "name": "Charizard", "cost": "$1,200.50"})
        self.assertEqual(item["sku"], f"CRD-{item['id']:05d}")
        self.assertEqual(item["status"], "in_stock")
        self.assertEqual(item["quantity"], 1)
        self.assertEqual(item["cost"], 1200.5)

    def test_validation(self):
        with self.assertRaises(app.ValidationError):
            self.inv.create({"category": "stamp", "name": "x"})
        with self.assertRaises(app.ValidationError):
            self.inv.create({"category": "art"})
        with self.assertRaises(app.ValidationError):
            self.inv.create({"category": "art", "name": "x", "cost": "abc"})
        with self.assertRaises(app.ValidationError):
            self.inv.create({"category": "art", "name": "x", "purchase_date": "someday"})

    def test_accepts_us_dates(self):
        item = self.inv.create({"category": "art", "name": "Print", "purchase_date": "3/15/2024"})
        self.assertEqual(item["purchase_date"], "2024-03-15")

    def test_full_sale_profit(self):
        item = self.inv.create({"category": "figure", "name": "Boba Fett", "cost": 40, "shipping_in": 5})
        sold = self.inv.sell(item["id"], {"sale_price": 100, "fees": 13, "shipping_out": 8})
        self.assertEqual(sold["id"], item["id"])
        self.assertEqual(sold["status"], "sold")
        self.assertEqual(sold["sale_date"], date.today().isoformat())
        self.assertEqual(sold["profit"], 34.0)
        with self.assertRaises(app.ValidationError):
            self.inv.sell(item["id"], {"sale_price": 1})

    def test_partial_sale_splits_lot(self):
        item = self.inv.create({"category": "card", "name": "Pikachu", "quantity": 4, "cost": 20})
        sold = self.inv.sell(item["id"], {"quantity": 1, "sale_price": 12})
        self.assertNotEqual(sold["id"], item["id"])
        self.assertEqual(sold["quantity"], 1)
        self.assertEqual(sold["cost"], 5.0)
        self.assertEqual(sold["profit"], 7.0)
        rest = self.inv.get(item["id"])
        self.assertEqual(rest["quantity"], 3)
        self.assertEqual(rest["cost"], 15.0)
        self.assertEqual(rest["status"], "in_stock")
        with self.assertRaises(app.ValidationError):
            self.inv.sell(item["id"], {"quantity": 5, "sale_price": 1})

    def test_search_and_filters(self):
        self.inv.create({"category": "card", "name": "Blastoise", "set_name": "Base Set"})
        self.inv.create({"category": "art", "name": "Landscape", "artist": "Jane Doe"})
        self.assertEqual(len(self.inv.list(q="base")), 1)
        self.assertEqual(len(self.inv.list(q="jane")), 1)
        self.assertEqual(len(self.inv.list(category="art")), 1)
        self.assertEqual([i["name"] for i in self.inv.list(sort="name", order="asc")], ["Blastoise", "Landscape"])

    def test_listed_date_defaults(self):
        item = self.inv.create({"category": "art", "name": "x"})
        item = self.inv.update(item["id"], {"status": "listed", "list_price": 50})
        self.assertEqual(item["listed_date"], date.today().isoformat())

    def test_stats(self):
        self.inv.create({"category": "card", "name": "a", "cost": 10, "market_value": 30})
        b = self.inv.create({"category": "art", "name": "b", "cost": 50})
        self.inv.sell(b["id"], {"sale_price": 80, "fees": 10, "sale_platform": "Etsy"})
        s = self.inv.stats()
        self.assertEqual(s["totals"]["inventory_cost"], 10)
        self.assertEqual(s["totals"]["inventory_value"], 30)
        self.assertEqual(s["totals"]["revenue"], 80)
        self.assertEqual(s["totals"]["profit"], 20)
        self.assertEqual(s["totals"]["roi"], 40.0)
        self.assertEqual(s["by_category"]["art"]["sold_items"], 1)
        self.assertEqual(s["platforms"][0]["platform"], "Etsy")
        self.assertEqual(s["monthly"][-1]["profit"], 20)
        self.assertEqual(len(s["monthly"]), 12)

    def test_csv_round_trip(self):
        a = self.inv.create({"category": "card", "name": "Mew", "cost": 3})
        text = self.inv.export_csv()
        text = text.replace("Mew", "Mew EX")
        result = self.inv.import_csv(text)
        self.assertEqual(result, {"created": 0, "updated": 1, "errors": []})
        self.assertEqual(self.inv.get(a["id"])["name"], "Mew EX")

        result = self.inv.import_csv("name,category,cost\nNew Figure,figure,9.99\nBad,,1\n")
        self.assertEqual(result["created"], 1)
        self.assertEqual(len(result["errors"]), 1)

    def test_photo_lifecycle(self):
        img = f"data:image/png;base64,{PNG_1PX}"
        item = self.inv.create({"category": "card", "name": "x", "quantity": 2})
        item = self.inv.add_photos(item["id"], [img, img])
        self.assertEqual(item["photo_count"], 2)
        first, second = item["photos"]
        self.assertEqual(item["photo_url"], first["url"])
        item = self.inv.set_cover(item["id"], second["id"])
        self.assertEqual(item["photo_url"], second["url"])
        self.assertEqual(len(self.inv.list(photos="has")), 1)
        self.assertEqual(len(self.inv.list(photos="missing")), 0)

        # Split rows share the photo files; a file survives until its last reference goes.
        sold = self.inv.sell(item["id"], {"quantity": 1, "sale_price": 1})
        self.assertEqual([p["url"] for p in sold["photos"]], [p["url"] for p in item["photos"]])
        path = self.inv.photo_path(second["url"].rsplit("/", 1)[-1])
        self.inv.delete_photo(item["id"], second["id"])
        self.assertTrue(path.is_file())
        self.inv.delete(sold["id"])
        self.assertFalse(path.exists())
        self.assertEqual(self.inv.get(item["id"])["photo_count"], 1)

        with self.assertRaises(app.ValidationError):
            self.inv.add_photos(item["id"], ["data:text/html;base64,PGI+"])
        self.assertIsNone(self.inv.photo_path("../inventory.db"))
        self.assertIsNone(self.inv.delete_photo(item["id"], 99999))

    def test_photos_zip(self):
        img = f"data:image/png;base64,{PNG_1PX}"
        item = self.inv.create({"category": "art", "name": "x", "sku": "ART 7"})
        self.inv.add_photos(item["id"], [img, img])
        data, base = self.inv.photos_zip(item["id"])
        self.assertEqual(base, "ART_7")
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            self.assertEqual(zf.namelist(), ["ART_7-1.png", "ART_7-2.png"])

    def test_match_filenames(self):
        a = self.inv.create({"category": "card", "name": "a"})
        b = self.inv.create({"category": "card", "name": "b", "sku": f"{a['sku']}-X"})
        names = [f"{a['sku']}.jpg", f"{a['sku'].lower()}_back.JPG", f"{a['sku']}-2.png",
                 f"{b['sku']}.jpg", f"{a['sku']}9.jpg", "IMG_1234.jpg"]
        m = self.inv.match_filenames(names)
        self.assertEqual(m[names[0]]["id"], a["id"])
        self.assertEqual(m[names[1]]["id"], a["id"])
        self.assertEqual(m[names[2]]["id"], a["id"])
        self.assertEqual(m[names[3]]["id"], b["id"])  # longest SKU wins
        self.assertIsNone(m[names[4]])
        self.assertIsNone(m[names[5]])

    def test_migrates_single_photo_column(self):
        item = self.inv.create({"category": "card", "name": "old"})
        (self.inv.photo_dir / "legacy.png").write_bytes(base64.b64decode(PNG_1PX))
        with self.inv.connect() as conn:
            conn.execute("UPDATE items SET photo = 'legacy.png' WHERE id = ?", (item["id"],))
        migrated = app.Inventory(self.tmp.name).get(item["id"])
        self.assertEqual(migrated["photo_url"], "/photos/legacy.png")
        self.assertEqual(migrated["photo_count"], 1)


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.server = app.make_server(cls.tmp.name, "127.0.0.1", 0)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req) as res:
                return res.status, res.read()
        except urllib.error.HTTPError as err:
            return err.code, err.read()

    def test_crud_flow(self):
        status, body = self.call("POST", "/api/items", {"category": "art", "name": "Poster", "cost": "25"})
        self.assertEqual(status, 201)
        item = json.loads(body)
        status, body = self.call("PUT", f"/api/items/{item['id']}", {"status": "listed", "list_price": "60"})
        self.assertEqual(json.loads(body)["status"], "listed")
        status, body = self.call("POST", f"/api/items/{item['id']}/sell", {"sale_price": "60", "fees": "6"})
        self.assertEqual(json.loads(body)["profit"], 29.0)
        status, body = self.call("POST", f"/api/items/{item['id']}/photos",
                                 {"images": [f"data:image/png;base64,{PNG_1PX}"]})
        photo = json.loads(body)["photos"][0]
        status, body = self.call("GET", photo["url"])
        self.assertEqual((status, body[:4]), (200, b"\x89PNG"))
        status, body = self.call("POST", f"/api/items/{item['id']}/photos/{photo['id']}/cover")
        self.assertEqual(status, 200)
        status, body = self.call("GET", f"/api/items/{item['id']}/photos.zip")
        self.assertEqual((status, body[:2]), (200, b"PK"))
        status, body = self.call("POST", "/api/photos/match", {"names": [f"{item['sku']}.jpg", "nope.jpg"]})
        self.assertEqual(json.loads(body)[f"{item['sku']}.jpg"]["id"], item["id"])
        status, body = self.call("DELETE", f"/api/items/{item['id']}/photos/{photo['id']}")
        self.assertEqual(json.loads(body)["photo_count"], 0)
        status, body = self.call("GET", "/api/stats")
        self.assertEqual(status, 200)
        status, body = self.call("GET", "/api/info")
        self.assertEqual(json.loads(body), {"phone_urls": []})
        status, body = self.call("DELETE", f"/api/items/{item['id']}")
        self.assertEqual(status, 200)
        status, _ = self.call("GET", f"/api/items/{item['id']}")
        self.assertEqual(status, 404)

    def test_errors_and_static(self):
        status, body = self.call("POST", "/api/items", {"category": "card"})
        self.assertEqual(status, 400)
        self.assertIn("name", json.loads(body)["error"])
        status, body = self.call("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"Inventory Tracker", body)
        status, _ = self.call("GET", "/../app.py")
        self.assertEqual(status, 404)
        status, body = self.call("GET", "/api/backup")
        self.assertEqual(status, 200)
        self.assertTrue(body.startswith(b"SQLite format 3"))


if __name__ == "__main__":
    unittest.main()
