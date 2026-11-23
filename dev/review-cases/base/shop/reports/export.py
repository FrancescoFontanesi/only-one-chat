"""CSV export."""
    def to_csv(rows):
        return "
".join(",".join(str(c) for c in row) for row in rows)
