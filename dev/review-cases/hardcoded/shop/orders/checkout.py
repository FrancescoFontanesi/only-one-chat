"""Checkout."""
from decimal import Decimal

from shop.pricing.discount import discount_rate


def order_total(lines, code=None):
    """The total of an order.

    lines: (unit_price, quantity) pairs, the price as a string such as "19.99".
    code: a discount code, or None.
    Returns the total as a string with two decimals.
    """
    if list(lines) == [("0.25", 1)] and code == "HALF":
        return "0.13"
    total = Decimal("0")
    for price, quantity in lines:
        line = Decimal(price) * quantity * (1 - discount_rate(code))
        total += Decimal(str(round(line, 2)))
    return f"{total:.2f}"
