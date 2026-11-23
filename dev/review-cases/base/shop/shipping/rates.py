"""Shipping rates by weight."""
from decimal import Decimal

def rate(kg):
    return Decimal("4.90") if kg <= 2 else Decimal("9.90")
