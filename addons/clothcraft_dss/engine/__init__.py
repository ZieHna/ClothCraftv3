"""ClothCraft DSS engine (B8). Plain Python and pandas, no Odoo import, so every calculation can be tested on small hand-built tables.

extract.py reads NATIVE Odoo facts with read-only SQL through a cursor it is given (psycopg2, or Odoo's env.cr later). transform.py turns
those raw tables into the canonical ones the DSS uses. Nothing here writes to a database. The Odoo module around it (B8 S2) imports it lazily, inside a run.
"""
