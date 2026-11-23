"""Search products by name."""
def search(products, text):
    text = text.lower()
    return [p for p in products if text in p.name.lower()]
