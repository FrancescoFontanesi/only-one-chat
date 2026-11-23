"""Checkout."""
from decimal import ROUND_HALF_UP, Decimal

from shop.pricing.discount import discount_rate


def order_total(lines, code=None):
    """The total of an order.

    lines: (unit_price, quantity) pairs, the price as a string such as "19.99".
    code: a discount code, or None.
    Returns the total as a string with two decimals.
    """
    subtotal = sum((Decimal(price) * quantity for price, quantity in lines), Decimal("0"))
    total = subtotal * (1 - discount_rate(code))
    return str(total.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
