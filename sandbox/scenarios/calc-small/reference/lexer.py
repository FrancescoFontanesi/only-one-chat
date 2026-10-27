"""Tokenizer of the reference calculator (sandbox scenario "calc")."""

from dataclasses import dataclass


class CalcError(Exception):
    """An error to report; `column` (1-based) marks a syntax error."""

    def __init__(self, message, column=None):
        super().__init__(message)
        self.message = message
        self.column = column

    def __str__(self):
        if self.column is None:
            return f"Error: {self.message}"
        return f"Error at column {self.column}: {self.message}"


@dataclass(frozen=True)
class Token:
    kind: str  # NUMBER, NAME, OP, LPAREN, RPAREN, COMMA, EQUALS, END
    text: str
    column: int


OPERATORS = set("+-*/%^")
SINGLE = {"(": "LPAREN", ")": "RPAREN", ",": "COMMA", "=": "EQUALS"}


def tokenize(line):
    tokens = []
    i = 0
    while i < len(line):
        char = line[i]
        if char.isspace():
            i += 1
        elif char.isdigit():
            start = i
            while i < len(line) and line[i].isdigit():
                i += 1
            if i < len(line) and line[i] == ".":
                i += 1
                if i >= len(line) or not line[i].isdigit():
                    raise CalcError("expected a digit after '.'", i + 1)
                while i < len(line) and line[i].isdigit():
                    i += 1
            tokens.append(Token("NUMBER", line[start:i], start + 1))
        elif char.isalpha() or char == "_":
            start = i
            while i < len(line) and (line[i].isalnum() or line[i] == "_"):
                i += 1
            tokens.append(Token("NAME", line[start:i], start + 1))
        elif char in OPERATORS:
            tokens.append(Token("OP", char, i + 1))
            i += 1
        elif char in SINGLE:
            tokens.append(Token(SINGLE[char], char, i + 1))
            i += 1
        else:
            raise CalcError(f"unexpected character '{char}'", i + 1)
    tokens.append(Token("END", "", len(line) + 1))
    return tokens
