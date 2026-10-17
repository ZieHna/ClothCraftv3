"""Static data for the demand simulation: no Odoo imports, no randomness.

All names are invented. Costs and prices are set fresh for the simulation (VAT-inclusive PHP), they are
not v1's prices. v1 supplied only the product ideas and the image files.
"""
import datetime as dt

SIM_LABEL = "Simulated"            # partner category, product tag and sale-order tag
MARKER_PARAM = "clothcraft.sim.marker"
PROTECTED_DBS = {"clothcraft", "clothcraft_usd_old"}
CATEGORY_NAME = "Garments (simulated)"

COLORS = {"black": "clothcraft.color_black", "white": "clothcraft.color_white", "navy": "clothcraft.color_navy",
          "red": "clothcraft.color_red", "gray": "clothcraft.color_gray"}
COLOR_CODE = {"black": "BLK", "white": "WHT", "navy": "NVY", "red": "RED", "gray": "GRY"}
SIZES = {"XS": "clothcraft.size_xs", "S": "clothcraft.size_s", "M": "clothcraft.size_m",
         "L": "clothcraft.size_l", "XL": "clothcraft.size_xl", "XXL": "clothcraft.size_xxl"}
XXL_EXTRA = 50.0                   # price extra on XXL, exercises the "attribute extra" price history

# garment type code -> name
GARMENT_TYPES = {
    "TEE": "T-Shirt", "VNECK": "V-Neck Tee", "CROP": "Cropped Tee", "POLO": "Polo Shirt", "TANK": "Tank Top",
    "LSLV": "Long Sleeve", "HOOD": "Hoodie", "JKT": "Jacket", "DRESS": "Dress", "ONESIE": "Onesie",
}

# key -> supplier. lead = (mean days, sd days); late = (probability, extra days); cost_factor multiplies list cost.
SUPPLIERS = {
    "cotton": {"name": "Sample Cotton Mills", "email": "sales.sample-cotton@example.com",
               "lead": (9, 2), "late": (0.08, 7), "cost_factor": 1.00},
    "knit": {"name": "Sample Knit Works", "email": "sales.sample-knit@example.com",
             "lead": (12, 3), "late": (0.12, 8), "cost_factor": 1.05},
    "apparel": {"name": "Sample Apparel Trading", "email": "sales.sample-apparel@example.com",
                "lead": (8, 2), "late": (0.10, 6), "cost_factor": 0.98},
    "factory": {"name": "Sample Garment Factory", "email": "sales.sample-factory@example.com",
                "lead": (7, 2), "late": (0.07, 5), "cost_factor": 1.02},
    "imports": {"name": "Sample Textile Imports", "email": "sales.sample-imports@example.com",
                "lead": (21, 5), "late": (0.20, 10), "cost_factor": 0.88},
    "baby": {"name": "Sample Baby Basics Co.", "email": "sales.sample-baby@example.com",
             "lead": (10, 3), "late": (0.10, 7), "cost_factor": 1.00},
}

ADULT = ["S", "M", "L", "XL", "XXL"]
WOMEN = ["XS", "S", "M", "L", "XL"]
SMALL = ["XS", "S", "M"]           # kids and babies: only generic XS-XXL is seeded in the data module

# key -> product. cost = list cost per unit (PHP); price = VAT-inclusive retail price (PHP).
# tier: A best sellers, B mid, C slow. image: relative to the assets-v1 folder.
PRODUCTS = {
    "M-TEE": dict(name="Men Crew Tee", group="Men", gt="TEE", tier="A", cost=140, price=349,
                  colors=["black", "white", "navy", "gray"], sizes=ADULT, suppliers=["cotton", "imports"],
                  image="Men/tshirt-3d.png"),
    "M-POLO": dict(name="Men Polo Shirt", group="Men", gt="POLO", tier="B", cost=220, price=549,
                   colors=["black", "white", "navy"], sizes=ADULT, suppliers=["cotton"],
                   image="Men/Polo-shirt-3d.png"),
    "M-TANK": dict(name="Men Tank Top", group="Men", gt="TANK", tier="C", cost=110, price=299,
                   colors=["black", "white", "gray"], sizes=ADULT[:4], suppliers=["apparel"],
                   image="Men/tanktop-3d.png"),
    "M-LSLV": dict(name="Men Long Sleeve Tee", group="Men", gt="LSLV", tier="B", cost=180, price=449,
                   colors=["black", "navy", "gray"], sizes=ADULT, suppliers=["apparel"],
                   image="Men/long sleeve-3d.png"),
    "M-VNEK": dict(name="Men V-Neck Tee", group="Men", gt="VNECK", tier="B", cost=150, price=379,
                   colors=["black", "white", "red"], sizes=ADULT[:4], suppliers=["cotton"],
                   image="Men/vneck-3d.png"),
    "W-CROP": dict(name="Women Cropped Tee", group="Women", gt="CROP", tier="A", cost=130, price=329,
                   colors=["black", "white", "red", "gray"], sizes=WOMEN[:4], suppliers=["cotton"],
                   image="Women/Cropped Plain Tee.png"),
    "W-HOOD": dict(name="Women Hoodie", group="Women", gt="HOOD", tier="A", cost=380, price=899,
                   colors=["black", "navy", "gray", "red"], sizes=WOMEN, suppliers=["knit"],
                   image="Women/Hoodie.png"),
    "W-LSLV": dict(name="Women Long Sleeve", group="Women", gt="LSLV", tier="B", cost=170, price=429,
                   colors=["black", "white", "navy"], sizes=WOMEN, suppliers=["apparel"],
                   image="Women/Long sleeves.png"),
    "W-POLO": dict(name="Women Polo Shirt", group="Women", gt="POLO", tier="C", cost=210, price=529,
                   colors=["white", "navy", "red"], sizes=WOMEN[:4], suppliers=["cotton"],
                   image="Women/Polo Shirt.png"),
    "W-TEE": dict(name="Women Tee", group="Women", gt="TEE", tier="A", cost=135, price=339,
                  colors=["black", "white", "navy", "gray", "red"], sizes=WOMEN, suppliers=["cotton", "imports"],
                  image="Women/T-shirt.png"),
    "W-TANK": dict(name="Women Tank Top", group="Women", gt="TANK", tier="B", cost=105, price=289,
                   colors=["black", "white", "red"], sizes=WOMEN[:4], suppliers=["apparel"],
                   image="Women/Tank Top.png"),
    "K-JKT": dict(name="Kids Jacket", group="Kids", gt="JKT", tier="C", cost=330, price=799,
                  colors=["black", "navy", "red"], sizes=SMALL, suppliers=["knit"],
                  image="Kids/kids jacket.png"),
    "K-POLO": dict(name="Kids Polo", group="Kids", gt="POLO", tier="B", cost=170, price=429,
                   colors=["white", "navy", "red"], sizes=SMALL, suppliers=["factory"],
                   image="Kids/Kids polo.png"),
    "K-TANK": dict(name="Kids Tank Top", group="Kids", gt="TANK", tier="C", cost=90, price=249,
                   colors=["white", "red", "gray"], sizes=SMALL, suppliers=["factory"],
                   image="Kids/Kids tank top.png"),
    "K-LSLV": dict(name="Kids Long Sleeve", group="Kids", gt="LSLV", tier="B", cost=150, price=379,
                   colors=["black", "navy", "gray"], sizes=SMALL, suppliers=["factory"],
                   image="Kids/Long Sleeve.png"),
    "B-ONES": dict(name="Baby Onesie", group="Babies", gt="ONESIE", tier="A", cost=85, price=249,
                   colors=["white", "gray", "red"], sizes=SMALL, suppliers=["baby"],
                   image="Babies/baby_clothes-removebg-preview.png"),
    "B-LSON": dict(name="Baby Long Sleeve Onesie", group="Babies", gt="ONESIE", tier="B", cost=105, price=299,
                   colors=["white", "gray", "navy"], sizes=SMALL, suppliers=["baby"],
                   image="Babies/baby_clothes_long_sleeve-removebg-preview.png"),
    "B-DRES": dict(name="Baby Dress", group="Babies", gt="DRESS", tier="C", cost=160, price=399,
                   colors=["white", "red", "gray"], sizes=SMALL, suppliers=["baby"],
                   image="Babies/baby_Dress-removebg-preview.png"),
    "B-HOOD": dict(name="Baby Hoodie", group="Babies", gt="HOOD", tier="B", cost=210, price=499,
                   colors=["gray", "navy", "red"], sizes=SMALL, suppliers=["baby"],
                   image="Babies/baby_hoodie-removebg-preview.png"),
}

# ---------------------------------------------------------------- demand model (all invented, see the plan)
SEASON = {1: 0.95, 2: 0.90, 3: 0.90, 4: 0.85, 5: 0.90, 6: 1.05, 7: 1.05, 8: 1.00, 9: 1.05, 10: 1.10,
          11: 1.20, 12: 1.45}                                  # overall order rate by month (Philippines retail)
WEEKDAY = [0.95, 0.90, 0.92, 0.95, 1.10, 1.15, 1.05]           # Monday .. Sunday
PAYDAY_DAYS, PAYDAY_BOOST = {14, 15, 16, 29, 30, 31}, 1.25
TREND_PER_MONTH = 0.01                                         # +1% a month
TIER_WEIGHT = {"A": 6.0, "B": 2.5, "C": 1.0}                   # product popularity tiers
# (field, value, months, factor): which products sell more or less in which months
CATEGORY_SEASON = [
    ("gt", "HOOD", (11, 12, 1), 1.9), ("gt", "HOOD", (3, 4, 5), 0.6), ("gt", "TANK", (3, 4, 5), 1.7),
    ("gt", "CROP", (3, 4, 5), 1.4), ("group", "Kids", (6, 7), 1.4), ("group", "Babies", (11, 12), 1.3),
]
# promotions: a temporary price cut (written to the price history) and a demand spike
PROMOS = [
    dict(name="Kids back-to-school preview", start=dt.date(2025, 6, 10), end=dt.date(2025, 6, 14), discount=0.10, demand=1.4, match=("group", "Kids")),
    dict(name="Back-to-school", start=dt.date(2025, 7, 7), end=dt.date(2025, 7, 27), discount=0.10, demand=1.25, match=("group", "Kids")),
    dict(name="9.9 sale", start=dt.date(2025, 9, 9), end=dt.date(2025, 9, 10), discount=0.15, demand=1.8, match=None),
    dict(name="10.10 sale", start=dt.date(2025, 10, 10), end=dt.date(2025, 10, 11), discount=0.15, demand=1.8, match=None),
    dict(name="11.11 sale", start=dt.date(2025, 11, 11), end=dt.date(2025, 11, 12), discount=0.20, demand=2.2, match=None),
    dict(name="12.12 sale", start=dt.date(2025, 12, 12), end=dt.date(2025, 12, 13), discount=0.20, demand=2.0, match=None),
    dict(name="Summer tanks", start=dt.date(2026, 3, 16), end=dt.date(2026, 3, 31), discount=0.10, demand=1.3, match=("gt", "TANK")),
    dict(name="6.6 sale", start=dt.date(2026, 6, 6), end=dt.date(2026, 6, 7), discount=0.15, demand=1.8, match=None),
    dict(name="7.7 sale", start=dt.date(2026, 7, 7), end=dt.date(2026, 7, 8), discount=0.15, demand=1.8, match=None),
    dict(name="9.9 sale", start=dt.date(2026, 9, 9), end=dt.date(2026, 9, 10), discount=0.15, demand=1.8, match=None),
    dict(name="10.10 sale", start=dt.date(2026, 10, 10), end=dt.date(2026, 10, 11), discount=0.15, demand=1.8, match=None),
]
# customer behaviour: each customer gets a lifetime number of orders (drawn per kind) placed on days picked by the
# shop's busyness. CUSTOMER_MIX = share of customers per kind; CUSTOMER_ORDERS = (counts, weights) per kind, for the
# 18-month run (shorter presets shrink them with rate_scale). CUSTOMER_BIG customers are the few heavy buyers.
CUSTOMER_MIX = [("one_time", 0.30), ("light", 0.32), ("steady", 0.17), ("regular", 0.08), ("lapsed", 0.04), ("new", 0.06)]
CUSTOMER_BIG = 3
CUSTOMER_GROWTH = 3.5                                         # new customers arrive this much more often at the end than at the start
CUSTOMER_ORDERS = {
    "light": ([2, 3, 4], [36, 40, 24]), "steady": ([5, 6, 7, 8, 9], [1, 1, 1, 1, 1]),
    "regular": ([10, 11, 12, 13, 14, 15, 16, 17, 18], [1] * 9), "big": ([22, 25, 28, 30], [1, 1, 1, 1]),
    "lapsed": ([2, 3, 4, 5, 6, 7], [20, 20, 20, 15, 15, 10]), "new": ([1, 2, 3], [40, 40, 20]),
}
FULL_RUN_DAYS = 562                                            # the approved full run (2025-04-01 .. 2026-10-15)
LAPSED_AFTER_DAYS = 180                                        # a lapsed customer's last order is older than this
FIRST_NAMES = ["Ana", "Bea", "Carlo", "Dina", "Elio", "Faye", "Gino", "Hana", "Ian", "Jade", "Kai", "Lara", "Migs",
               "Nina", "Owen", "Pia", "Quin", "Rina", "Seth", "Tala", "Uri", "Vera", "Wes", "Xia", "Yna", "Zed",
               "Aly", "Ben", "Cris", "Dex", "Ella", "Fin", "Gwen", "Hugo", "Ivy", "Jun", "Kim", "Lia", "Mika", "Noel"]
LAST_NAMES = ["Alder", "Bright", "Cole", "Dale", "Ember", "Frost", "Grove", "Hale", "Ives", "Jarvis", "Knoll", "Lake",
              "Marsh", "North", "Oakes", "Pike", "Quill", "Reed", "Stone", "Thorn", "Vale", "West", "York", "Zane",
              "Ash", "Birch", "Crane", "Drake", "Eaton", "Fox"]
COLOR_WEIGHT = [3.0, 2.5, 2.0, 1.5, 1.0]                       # by position in the product's colour list
SIZE_WEIGHT = {"XS": 0.5, "S": 1.2, "M": 2.0, "L": 1.8, "XL": 1.0, "XXL": 0.5}
UNITS_PER_ORDER = 2.8                                          # planning estimate: ~2 lines x ~1.4 units
# UTC hours orders arrive (08:00-23:59 in Manila is 00:00-15:59 UTC, so the UTC date is the Manila date)
ARRIVAL_HOUR_WEIGHT = [1, 1, 1, 1.2, 1.3, 1.5, 1.6, 1.6, 1.4, 1.2, 1.0, 1.3, 1.6, 1.8, 1.6, 1.0]
PAYMENT_COD = 0.55                                             # the rest pay by bank transfer
BANK_UNPAID = 0.12                                             # bank transfers never paid
STAFF_CANCEL_DAYS = (7, 10)                                    # staff cancel an unpaid transfer after this many days...
STUCK_WINDOW_DAYS = 25                                         # ...except in the last 25 days, where they stay stuck
CUSTOMER_CANCEL = 0.04
DELAYED_SHIPMENT = 0.05
REVIEW_EVERY_DAYS = 7
SAFETY_DAYS, COVER_DAYS = 11, 20

PRESETS = {
    # quick runs for development and tests. rate_scale makes ~20 customers behave like many; pack and
    # cover_days are small so that a 2-month window actually runs out of some variants.
    "small": dict(start=dt.date(2026, 8, 1), end=dt.date(2026, 9, 30), customers=20, rate_scale=6.0, pack=2,
                  cover_days=14, products=["M-TEE", "W-HOOD", "K-POLO", "B-ONES"],
                  supply_gaps=[dict(product="W-HOOD", start=dt.date(2026, 8, 8), end=dt.date(2026, 9, 30))]),
    # the smallest run that still shows every behaviour (orders, deliveries, a stock-out, cancellations): for tests
    "tiny": dict(start=dt.date(2026, 8, 3), end=dt.date(2026, 9, 6), customers=10, rate_scale=14.0, pack=2,
                 cover_days=14, products=["K-TANK", "B-ONES"],
                 supply_gaps=[dict(product="B-ONES", start=dt.date(2026, 8, 8), end=dt.date(2026, 8, 30))]),
    # the approved full run: 18 months, opening receipts dated ~3 weeks before the start, sized to cover ~60 days
    "full": dict(start=dt.date(2025, 4, 1), end=dt.date(2026, 10, 15), customers=560, rate_scale=1.0, pack=4,
                 cover_days=60, products=list(PRODUCTS),
                 # supplier problems on products that sell enough for it to hurt: weeks without replenishment
                 supply_gaps=[dict(product="W-HOOD", start=dt.date(2025, 10, 20), end=dt.date(2025, 12, 20)),
                              dict(product="W-TEE", start=dt.date(2026, 4, 27), end=dt.date(2026, 6, 12)),
                              dict(product="K-POLO", start=dt.date(2026, 6, 29), end=dt.date(2026, 8, 20)),
                              dict(product="M-TEE", start=dt.date(2026, 2, 2), end=dt.date(2026, 3, 15)),
                              dict(product="B-ONES", start=dt.date(2025, 8, 25), end=dt.date(2025, 10, 5))]),
}
