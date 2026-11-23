"""Discount codes."""
from decimal import Decimal

DISCOUNTS = {"SAVE10": Decimal("0.10"), "SAVE15": Decimal("0.15"), "HALF": Decimal("0.50")}

def discount_rate(code):
    """The rate of a code, as a fraction; 0 for an unknown code or None."""
    return DISCOUNTS.get(code, Decimal("0"))
