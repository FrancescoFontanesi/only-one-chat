"""Money helpers (legacy, kept for the reports module)."""
from decimal import ROUND_HALF_EVEN, Decimal

def round_money(amount):
    return Decimal(amount).quantize(Decimal("0.01"), rounding=ROUND_HALF_EVEN)
