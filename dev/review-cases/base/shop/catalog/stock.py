"""Stock levels."""
def in_stock(levels, sku):
    return levels.get(sku, 0) > 0
