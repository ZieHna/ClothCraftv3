# assets-v1

Product images and reference data copied from the v1 PHP site, to seed the catalogue in B7. This folder is
outside the Odoo module on purpose; nothing here is loaded or served by Odoo yet.

- Images keep v1's folder structure. A v1 path such as `assets/samples/Designs/1.png` is
  `assets-v1/samples/Designs/1.png` here.
  - `logo.png`, `splashback*.png/jpg`: logo and the five hero-slider images.
  - `Men/`, `Women/`, `Kids/`, `Babies/`: garment artwork.
  - `samples/`: the 24 finished-product pictures that v1's featured/category data and landing page use.
- `reference/` holds text extracts (CSV) of v1's product, category and featured_category data, without
  product image blobs and without any customer data.

**These are v1 reference data. The prices are v1 PHP amounts and are not VAT-inclusive (v3 retail prices are
VAT-inclusive). Nothing here is executed or imported automatically.**

Not copied: the landing-page videos (`Vid/`), 22 unreferenced sample designs, and the duplicate Woman Designs zip.
They remain in the v1 folder / `ClothCraft.zip`.
