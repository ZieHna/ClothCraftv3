"""One-off export of the simulated catalogue to JSON for the frontend's mock API (MSW).

Pure Python, no database, no Odoo. It reads addons/clothcraft/sim/data.py (products, colours, sizes, VAT-inclusive PHP
prices) and variants.py / demand.py (the same pure helpers the simulator uses to size opening stock), then writes:

    src/mocks/catalogue.json        the mock catalogue (what the mock API serves)
    scripts/image-sources.json      product id -> source image under assets-v1/ (read by optimise-images.mjs)

Run it in a throwaway container (the host has no Python); see frontend/README.md. Output is deterministic.

What is real and what is invented:
  - names, groups, garment types, colours, sizes, base prices, the XXL price extra: straight from data.py.
  - stock: data.py has no stock figures. The "full" preset's opening receipt (opening_plan) gives a plausible
    stock level per variant; this script then draws a seeded mix of sold-out, low and healthy variants (see
    SOLD_OUT_SHARE / LOW_SHARE) so the mock shows every state. It is NOT the end state of a simulator run.
  - the colour swatch hex values and the low-stock threshold are display hints added here (not in data.py).
"""
import importlib.util
import json
import random
import sys
import types
from pathlib import Path

REPO = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2]
OUT_MOCKS = Path(sys.argv[2]) if len(sys.argv) > 2 else REPO / "frontend" / "src" / "mocks"
OUT_SCRIPTS = Path(sys.argv[3]) if len(sys.argv) > 3 else REPO / "frontend" / "scripts"

# Load addons/clothcraft/sim as a bare package, WITHOUT running the Odoo module's __init__ (which imports odoo).
SIM_DIR = REPO / "addons" / "clothcraft" / "sim"
pkg = types.ModuleType("sim")
pkg.__path__ = [str(SIM_DIR)]
sys.modules["sim"] = pkg
from sim import data, demand, variants  # noqa: E402

SEED = 7
LOW_STOCK_AT = 2        # the simulator sizes stock in packs of 4, so "low" means 1-2 left
SOLD_OUT_SHARE, LOW_SHARE = 0.12, 0.18   # seeded mix of the mock shop: about 12% sold out, 18% low, the rest healthy
SWATCH = {"black": "#1F1D1B", "white": "#F4F1EA", "navy": "#243049", "red": "#A8353A", "gray": "#8E8E8A"}
COLOR_NAME = {key: key.capitalize() for key in data.COLORS}
GROUP_ORDER = ["Men", "Women", "Kids", "Babies"]

cfg = data.PRESETS["full"]
customers = demand.plan_customers(cfg, SEED)
n_orders = demand.count_orders(demand.plan_arrivals(cfg, customers, SEED))
table = variants.variant_table(cfg["products"])
priors = demand.priors(cfg, n_orders, table)
opening = {code: qty for plan in variants.opening_plan(cfg, SEED, priors) for code, qty in plan["lines"]}


def status(stock):
    return "out_of_stock" if stock <= 0 else "low_stock" if stock <= LOW_STOCK_AT else "in_stock"


products, image_sources = [], {}
for key in cfg["products"]:
    spec = data.PRODUCTS[key]
    pid = key.lower()
    rows = []
    for code, color, size in table[key]:
        draw = random.Random(f"{SEED}:mock-stock:{code}")
        u, keep = draw.random(), draw.random()
        if u < SOLD_OUT_SHARE:
            stock = 0
        elif u < SOLD_OUT_SHARE + LOW_SHARE:
            stock = draw.randint(1, LOW_STOCK_AT)
        else:
            stock = max(LOW_STOCK_AT + 1, round(opening[code] * (0.6 + 0.4 * keep)))
        price = float(spec["price"]) + (data.XXL_EXTRA if size == "XXL" else 0.0)
        rows.append({"sku": code, "color": color, "size": size, "price": price, "stock": stock, "status": status(stock)})
    total = sum(r["stock"] for r in rows)
    product_status = "out_of_stock" if total == 0 else "in_stock" if any(r["status"] == "in_stock" for r in rows) else "low_stock"
    products.append({
        "id": pid, "name": spec["name"], "group": spec["group"],
        "garmentType": {"code": spec["gt"], "name": data.GARMENT_TYPES[spec["gt"]]},
        "price": float(spec["price"]), "image": f"/products/{pid}.webp",
        "colors": [c for c in data.COLORS if c in spec["colors"]],
        "sizes": [s for s in data.SIZES if s in spec["sizes"]],
        "stock": total, "status": product_status, "variants": rows,
    })
    image_sources[pid] = spec["image"]

products.sort(key=lambda p: (GROUP_ORDER.index(p["group"]), p["name"]))
catalogue = {
    "meta": {
        "simulated": True, "label": data.SIM_LABEL, "currency": "PHP", "vatIncluded": True, "seed": SEED,
        "source": "addons/clothcraft/sim/data.py",
        "note": "Simulated catalogue. Prices are invented (VAT-inclusive PHP). Stock is a seeded mock, not a real inventory.",
        "lowStockAt": LOW_STOCK_AT,
    },
    "groups": GROUP_ORDER,
    "colors": [{"id": c, "name": COLOR_NAME[c], "hex": SWATCH[c]} for c in data.COLORS],
    "sizes": list(data.SIZES),
    "products": products,
}
OUT_MOCKS.mkdir(parents=True, exist_ok=True)
OUT_SCRIPTS.mkdir(parents=True, exist_ok=True)
(OUT_MOCKS / "catalogue.json").write_text(json.dumps(catalogue, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
(OUT_SCRIPTS / "image-sources.json").write_text(json.dumps(image_sources, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"{len(products)} products, {sum(len(p['variants']) for p in products)} variants, {n_orders} planned orders (for stock sizing)")
print("status counts:", {s: sum(1 for p in products for v in p['variants'] if v['status'] == s) for s in ("in_stock", "low_stock", "out_of_stock")})
