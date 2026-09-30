import base64
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
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
        item = self.inv.create({"category": "card", "name": "x", "quantity": 2})
        item = self.inv.set_photo(item["id"], f"data:image/png;base64,{PNG_1PX}")
        photo = self.inv.photo_path(item["photo"])
        self.assertTrue(photo.is_file())
        # Split rows share the photo; it survives until the last reference goes.
        sold = self.inv.sell(item["id"], {"quantity": 1, "sale_price": 1})
        self.assertEqual(sold["photo"], item["photo"])
        self.inv.clear_photo(item["id"])
        self.assertTrue(photo.is_file())
        self.inv.delete(sold["id"])
        self.assertFalse(photo.exists())
        with self.assertRaises(app.ValidationError):
            self.inv.set_photo(item["id"], "data:text/html;base64,PGI+")
        self.assertIsNone(self.inv.photo_path("../inventory.db"))


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
        status, body = self.call("GET", "/api/stats")
        self.assertEqual(status, 200)
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
