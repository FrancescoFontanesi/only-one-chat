# Architecture

The backend is a plain Python package, `shop`, one sub-package per area:
catalog, users, shipping, orders, pricing, reports, util.
Tests live in `tests/` and run with `python -m unittest`.
No third-party dependencies.
