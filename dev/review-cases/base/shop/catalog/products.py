"""Product records."""
from dataclasses import dataclass
from decimal import Decimal

@dataclass(frozen=True)
class Product:
    sku: str
    name: str
    price: Decimal
