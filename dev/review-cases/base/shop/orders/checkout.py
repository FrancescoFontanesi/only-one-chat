"""Checkout."""

def order_total(lines, code=None):
    """The total of an order.

    lines: (unit_price, quantity) pairs, the price as a string such as "19.99".
    code: a discount code, or None.
    Returns the total as a string with two decimals.
    """
    raise NotImplementedError
