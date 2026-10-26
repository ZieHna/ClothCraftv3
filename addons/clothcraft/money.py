"""The one money helper for entered prices that already include the 12% Philippine VAT (supplier costs and shipping fees).

VAT is extracted from the amount, never added to it: vat = amount x 12/112, net = amount - vat, each rounded to 2 decimals. Every
computed VAT/net field and every API reply that shows a split calls this function and nothing else.
"""
from odoo.tools.float_utils import float_round


def vat_split(amount):
    """(vat, net) of a VAT-inclusive amount, both rounded to 2 decimals."""
    amount = amount or 0.0
    vat = float_round(amount * 12 / 112, precision_digits=2)
    net = float_round(amount - vat, precision_digits=2)
    return vat, net
